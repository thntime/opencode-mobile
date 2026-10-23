import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';

import {
  clearRelayConnectionState,
  findMatchingProfile,
  loadConnectionProfiles,
  pickModelPreferences,
  mutateConnectionProfiles,
} from '@/lib/connection-profiles';
import { getConnectCredentialError } from '@/lib/connect';
import { isRelayReauthRequired, refreshRelayToken, relayWithoutHost } from '@/lib/relay/refresh';
import {
  buildClient,
  classifyConnectionFailure,
  detectServerContract,
  getConnectionError,
  getNormalizedServerUrl,
  isContractMismatchError,
  isAuthConnectionFailure,
  isRetryableCloudLinkStartupError,
  isValidServerUrl,
  type ConnectionFailureKind,
  type OpencodeConnectionSettings,
  type ScopedOpencodeClient,
  type ServerContract,
} from '@/lib/opencode/client';
import type { ChatPreferences, ConnectionState, ProjectCatalog } from '@/providers/opencode-provider-types';
import type { ConnectSetup } from '@/providers/use-connect-state';
import type { ConnectionActionsInput } from '@/providers/opencode-provider-action-inputs';

// Joining concurrent connects is keyed on the exact credentials and generation
// so a rotation that lands mid-flight starts a new attempt instead of adopting
// stale credentials.
function getConnectRequestKey(settings: OpencodeConnectionSettings, generation: number) {
  return [generation, settings.serverUrl, settings.username, settings.password, settings.connect?.machineId ?? '', settings.connect?.expiresAt ?? ''].join('\u0000');
}

export function useConnectionConnectActions({
  settings,
  connectSetup,
  setSettings,
  activeProjectPath,
  setActiveProjectPath,
  activeProjectPathRef,
  clearProjectState,
  softResetProjectState,
  isHydrated,
  isCurrentCatalogClient,
  loadProjectCatalog,
  serverProjectsRef,
  setServerProjects,
  setCurrentProjectPath,
  setServerRootPath,
  setSessions,
  setSessionStatuses,
  setCurrentConfig,
  setAvailableProviders,
  setProviderAuthMethodsById,
  setAvailableModels,
  setAvailableAgents,
  setChatPreferences,
  setDiagnostics,
  setSendingState,
  setConnection,
  setServerContract,
  settingsRef,
  chatPreferencesRef,
  serverContractRef,
  connectionRef,
  serverGenerationRef,
  catalogGenerationRef,
  scopeGenerationRef,
  initialConnectStartedRef,
}: ConnectionActionsInput & { connectSetup: ConnectSetup }) {
  const prepareConnectSettingsRef = useRef<(settings: OpencodeConnectionSettings) => Promise<OpencodeConnectionSettings>>(async (value) => value);
  const connectInFlightRef = useRef<{ key: string; promise: Promise<ConnectionState> } | undefined>(undefined);

  // A Relay session that cannot be refreshed is unrecoverable in place. Drop
  // the host selection in memory (the token and persisted host are cleared by
  // the refresh module) so the root guard routes back to /relay-login instead
  // of leaving the app parked on a fatal connection error.
  const dropRelayHost = useCallback(() => {
    const current = settingsRef.current;
    if (!current.relay?.hostId) return;
    const next = { ...current, relay: relayWithoutHost(current.relay) };
    settingsRef.current = next;
    setSettings(next);
  }, [settingsRef, setSettings]);

  const performConnect = useCallback(async (targetSettings: OpencodeConnectionSettings, onPrepared?: (prepared: OpencodeConnectionSettings) => void): Promise<ConnectionState> => {
    initialConnectStartedRef.current = true;
    let generation = serverGenerationRef.current;
    const current = () => generation === serverGenerationRef.current;
    if (targetSettings.connect) {
      try {
        const prepared = await prepareConnectSettingsRef.current(targetSettings);
        if (!current()) return connectionRef.current;
        const credentialError = getConnectCredentialError(prepared.connect, prepared.password);
        if (credentialError) throw new Error(credentialError);
        if (prepared.serverUrl !== settingsRef.current.serverUrl || prepared.username !== settingsRef.current.username || prepared.password !== settingsRef.current.password || prepared.connect?.expiresAt !== settingsRef.current.connect?.expiresAt) {
          const previous = settingsRef.current;
          const sameMachineRotation = Boolean(
            prepared.connect && previous.connect
            && prepared.connect.controlPlaneUrl === previous.connect.controlPlaneUrl
            && prepared.connect.machineId === previous.connect.machineId
            && prepared.serverUrl === previous.serverUrl,
          );
          settingsRef.current = prepared;
          setSettings(prepared);
          scopeGenerationRef.current += 1;
          serverGenerationRef.current += 1;
          generation = serverGenerationRef.current;
          // A same-machine credential renewal keeps project, session, terminal
          // and editor state; only client-bound in-flight bookkeeping resets.
          if (sameMachineRotation) softResetProjectState(); else clearProjectState();
        }
        targetSettings = prepared;
        onPrepared?.(prepared);
      } catch (reason) {
        if (!current()) return connectionRef.current;
        const failed: ConnectionState = { status: 'error', message: reason instanceof Error ? reason.message : 'Could not recover Cloud Link access.', kind: classifyConnectionFailure(reason), checkedAt: Date.now() };
        setConnection(failed);
        return failed;
      }
    }
    const credentialError = getConnectCredentialError(targetSettings.connect, targetSettings.password);
    if (credentialError) {
      const failed: ConnectionState = { status: 'error', message: credentialError, kind: 'auth', checkedAt: Date.now() };
      setConnection(failed);
      return failed;
    }
    // D2: Relay mode without a selected host has no request target at all.
    // Report "select a host" instead of an invalid URL, and let the guard keep
    // the user on /relay-hosts.
    if (targetSettings.relay && !targetSettings.relay.hostId) {
      const idle: ConnectionState = { status: 'idle', message: 'Select a Relay host to connect.', checkedAt: Date.now() };
      setConnection(idle);
      return idle;
    }
    if (!isValidServerUrl(targetSettings.serverUrl)) {
      const failed: ConnectionState = {
        status: 'error',
        message: getConnectionError(targetSettings.serverUrl, new Error('Invalid server URL.')),
        kind: 'unknown',
        checkedAt: Date.now(),
      };
      setConnection(failed);
      return failed;
    }

    setConnection({
      status: 'connecting',
      message: `Connecting to ${getNormalizedServerUrl(targetSettings.serverUrl)}...`,
    });

    // The SDK reads the relay token synchronously while building clients (SSE
    // headers come from `getRequestHeaders`), so hydrate the mirror before any
    // client is created on a cold start.
    if (targetSettings.relay) {
      const { getRelayToken } = await import('@/lib/relay/auth');
      await getRelayToken();
    }

    let detectedContract: ServerContract = 'v2';
    try {
      detectedContract = (await detectServerContract(targetSettings)).contract;
    } catch {
      detectedContract = 'v2';
    }
    if (!current()) return connectionRef.current;

    const candidates: ServerContract[] = detectedContract === 'v1' ? ['v1', 'v2'] : ['v2', 'v1'];
    let catalog: ProjectCatalog | undefined;
    let activeCatalogClient: ScopedOpencodeClient | undefined;
    let usedContract: ServerContract | undefined;
    let lastError: unknown;

    for (const candidate of candidates) {
      const candidateClient = buildClient({ ...targetSettings, directory: '' }, candidate);
      catalogGenerationRef.current.set(candidateClient, serverGenerationRef.current);
      try {
        const result = await loadProjectCatalog(true, candidateClient);
        if (!isCurrentCatalogClient(candidateClient)) {
          return connectionRef.current;
        }
        catalog = result;
        activeCatalogClient = candidateClient;
        usedContract = candidate;
        break;
      } catch (error) {
        if (!current()) return connectionRef.current;
        lastError = error;
        if (!isContractMismatchError(error)) {
          break;
        }
      }
    }

    if (!catalog || !activeCatalogClient || !usedContract) {
      const failure = lastError ?? new Error('Could not reach the OpenCode server.');
      // The refresh module already cleared the token and persisted host; drop
      // the in-memory host so the root guard redirects to the login screen.
      // Some SDK wrappers lose the error `code`, so a classified auth failure
      // is treated the same way on a relay connection.
      // `host-auth` is deliberately excluded: the OpenCode host asking for its
      // own Basic credentials is a host configuration problem, not a dead Relay
      // session, so the token and the selected host must survive it.
      if (targetSettings.relay && (isRelayReauthRequired(failure) || classifyConnectionFailure(failure) === 'auth')) dropRelayHost();
      const failed: ConnectionState = {
        status: 'error',
        message: getConnectionError(targetSettings.serverUrl, failure),
        retryableStartup: Boolean(targetSettings.connect) && isRetryableCloudLinkStartupError(lastError),
        kind: classifyConnectionFailure(failure),
        checkedAt: Date.now(),
      };
      setConnection(failed);
      if (!isAuthConnectionFailure(failed.kind ?? 'unknown')) return failed;
      serverProjectsRef.current = [];
      setServerProjects([]);
      setCurrentProjectPath(undefined);
      setServerRootPath(undefined);
      setSessions([]);
      setSessionStatuses({});
      setCurrentConfig(undefined);
      setAvailableProviders([]);
      setProviderAuthMethodsById({});
      setAvailableModels([]);
      setAvailableAgents([]);
      return failed;
    }

    if (usedContract !== serverContractRef.current) {
      serverContractRef.current = usedContract;
      setServerContract(usedContract);
    }

    const projectDirectory = catalog.currentProjectPath || catalog.serverRootPath;
    const connected: ConnectionState = {
      status: 'connected',
      message: `Connected to ${getNormalizedServerUrl(targetSettings.serverUrl)} (OpenCode ${usedContract === 'v2' ? '2.x' : '1.x'})`,
      checkedAt: Date.now(),
      projectDirectory,
    };
    setConnection(connected);

    if (!activeProjectPath && !catalog.currentProjectPath && !catalog.serverProjects[0]?.worktree) {
      setSessions([]);
      setSessionStatuses({});
      setCurrentConfig(undefined);
      setAvailableProviders([]);
      setProviderAuthMethodsById({});
      setAvailableModels([]);
      setAvailableAgents([]);
    }

    return connected;
  }, [activeProjectPath, catalogGenerationRef, clearProjectState, dropRelayHost, softResetProjectState, isCurrentCatalogClient, loadProjectCatalog, initialConnectStartedRef, serverContractRef, serverGenerationRef, scopeGenerationRef, settingsRef, setAvailableAgents, setAvailableModels, setAvailableProviders, setConnection, setCurrentConfig, setCurrentProjectPath, setProviderAuthMethodsById, setServerContract, setServerProjects, setServerRootPath, setSessionStatuses, setSessions, setSettings, serverProjectsRef, connectionRef]);

  const runConnect = useCallback((targetSettings: OpencodeConnectionSettings) => {
    const inFlight = connectInFlightRef.current;
    if (inFlight && inFlight.key === getConnectRequestKey(targetSettings, serverGenerationRef.current)) return inFlight.promise;
    const record = { key: '', promise: Promise.resolve(connectionRef.current) };
    record.promise = performConnect(targetSettings, (prepared) => {
      record.key = getConnectRequestKey(prepared, serverGenerationRef.current);
    }).finally(() => {
      if (connectInFlightRef.current === record) connectInFlightRef.current = undefined;
    });
    record.key = getConnectRequestKey(targetSettings, serverGenerationRef.current);
    connectInFlightRef.current = record;
    return record.promise;
  }, [connectionRef, performConnect, serverGenerationRef]);

  const connect = useCallback(() => runConnect(settingsRef.current), [runConnect, settingsRef]);

  // A revoked or invalid credential on the data plane cannot heal by retrying.
  // Cloud Link reuses its prepared credential/recovery path; a Relay JWT is
  // refreshed in place and the stream is rebuilt. Only when that refresh fails
  // (or for a direct server) does the provider surface recovery. Returning
  // true tells the realtime loop to reconnect with the fresh token.
  const handleStreamAuthFailure = useCallback(async (kind: ConnectionFailureKind): Promise<boolean> => {
    // An upstream host challenge is not a rejected Relay/Cloud Link credential:
    // refreshing or dropping the host cannot fix it, so never reconnect.
    if (kind === 'host-auth') return false;
    // A Relay 403 is an authorization decision. Reconnecting, refreshing the
    // token or dropping the host cannot change it, so surface it and keep the
    // session/host selection for when access is restored.
    if (kind === 'forbidden') {
      setConnection({
        status: 'error',
        kind: 'forbidden',
        message: 'The Relay refused this account (403). Restore access and reconnect.',
        checkedAt: Date.now(),
      });
      return false;
    }
    const current = settingsRef.current;
    if (current.connect) {
      void connect().catch(() => undefined);
      return false;
    }
    // Only 401 (`auth`) can be fixed by a new token; a 403/entitlement failure
    // would loop forever because refreshing cannot change authorization.
    if (current.relay && kind === 'auth') {
      const result = await refreshRelayToken(current.relay.relayUrl, current.relay.account);
      if (result.status === 'refreshed') return true;
      // D3: a missing password or an unreachable Relay is not a rejected
      // credential. Keep the host selection; the guard asks for the password
      // (the refresh module marks it) or the retryable network error is shown.
      if (result.reason === 'missing_password') return false;
      if (result.reason === 'unreachable') {
        setConnection({
          status: 'error',
          kind: 'offline',
          message: 'Could not reach the Relay. Check your network and try again.',
          checkedAt: Date.now(),
        });
        return false;
      }
      dropRelayHost();
      return false;
    }
    if (connectionRef.current.status === 'error' && connectionRef.current.kind === kind) return false;
    scopeGenerationRef.current += 1;
    serverGenerationRef.current += 1;
    clearProjectState();
    setSendingState({ active: false });
    setConnection({
      status: 'error',
      kind,
      message: kind === 'entitlement'
        ? 'Access was denied. Reconnect or restore access to continue.'
        : 'Authentication failed. Check the credentials and reconnect.',
      checkedAt: Date.now(),
    });
    return false;
  }, [clearProjectState, connect, connectionRef, dropRelayHost, scopeGenerationRef, serverGenerationRef, setConnection, setSendingState, settingsRef]);

  const updateSettings = useCallback((patch: Partial<OpencodeConnectionSettings>) => {
    const connectionChanged = (['serverUrl', 'username', 'password'] as const)
      .some((key) => patch[key] !== undefined && patch[key] !== settingsRef.current[key]);
    if (connectionChanged) {
      scopeGenerationRef.current += 1;
      serverGenerationRef.current += 1;
      setConnection({ status: 'idle', message: 'Connection settings changed. Reconnect to apply them.' });
      setActiveProjectPath(undefined);
      activeProjectPathRef.current = undefined;
      // The target identity decides whether session-id-keyed caches survive:
      // another server or relay host drops them, a credential change keeps them.
      clearProjectState({
        serverUrl: patch.serverUrl ?? settingsRef.current.serverUrl,
        username: patch.username ?? settingsRef.current.username,
      });
      serverProjectsRef.current = [];
      setServerProjects([]);
      setCurrentProjectPath(undefined);
      setServerRootPath(undefined);
      setDiagnostics(undefined);
    }
    setSettings((current) => ({
      ...current,
      ...patch,
      connect: connectionChanged ? patch.connect : current.connect,
    }));
  }, [activeProjectPathRef, clearProjectState, scopeGenerationRef, serverGenerationRef, serverProjectsRef, settingsRef, setActiveProjectPath, setConnection, setCurrentProjectPath, setDiagnostics, setServerRootPath, setServerProjects, setSettings]);

  const captureActiveProfilePreferences = useCallback(async () => {
    const identity = settingsRef.current;
    const modelPreferences = pickModelPreferences(chatPreferencesRef.current);
    await mutateConnectionProfiles(async (profiles, save) => {
      const active = findMatchingProfile(profiles, identity);
      if (!active) {
        return;
      }
      await save(profiles.map((profile) => (
        profile.id === active.id ? { ...profile, modelPreferences } : profile
      )));
    });
  }, [chatPreferencesRef, settingsRef]);

  const switchConnection = useCallback(async (
    next: Pick<OpencodeConnectionSettings, 'serverUrl' | 'username' | 'password' | 'connect'> & { relay?: OpencodeConnectionSettings['relay'] },
    modelPreferences?: Partial<ChatPreferences>,
  ) => {
    await captureActiveProfilePreferences().catch(() => undefined);

    // D1/D2: a target without a `relay` block is a direct connection. Drop the
    // Relay session and its persisted host selection before the new target is
    // written, so nothing keeps pointing at the old relay host.
    const leavingRelay = Boolean(settingsRef.current.relay) && !next.relay;
    if (leavingRelay) await clearRelayConnectionState();

    const connectMetadata = next.connect ?? findMatchingProfile(await loadConnectionProfiles(), next)?.connect;
    const targetSettings: OpencodeConnectionSettings = {
      ...settingsRef.current,
      ...next,
      connect: connectMetadata,
      // `relay` is not part of `next`'s required keys: write it explicitly so a
      // direct switch actually removes the block instead of inheriting it.
      relay: next.relay,
    };
    if (connectMetadata && settingsRef.current.connect?.controlPlaneUrl === connectMetadata.controlPlaneUrl
      && settingsRef.current.connect.machineId === connectMetadata.machineId) {
      return runConnect(targetSettings);
    }
    updateSettings({ ...next, connect: connectMetadata, relay: next.relay });
    settingsRef.current = targetSettings;
    if (modelPreferences) {
      setChatPreferences((current) => ({ ...current, ...modelPreferences }));
    }

    return runConnect(targetSettings);
  }, [captureActiveProfilePreferences, runConnect, settingsRef, setChatPreferences, updateSettings]);

  const connectPhaseRef = useRef(connectSetup.phase);
  const activationPaused = connectSetup.phase === 'waitingForApproval' || connectSetup.phase === 'delayed';
  useLayoutEffect(() => {
    prepareConnectSettingsRef.current = connectSetup.prepareSettings;
    connectPhaseRef.current = connectSetup.phase;
  });

  const connectAccessRefreshRef = useRef('');
  useEffect(() => {
    if (!isHydrated || !settings.connect) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let refreshTimer: ReturnType<typeof setTimeout>;
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      if (connectPhaseRef.current === 'waitingForApproval' || connectPhaseRef.current === 'delayed') return;
      const remaining = Date.parse(settings.connect!.expiresAt) - Date.now();
      const refreshKey = `${settings.connect!.controlPlaneUrl}:${settings.connect!.machineId}:${settings.connect!.expiresAt}`;
      const recover = getConnectCredentialError(settings.connect, settings.password) || connectionRef.current.status === 'error';
      if (!recover && connectAccessRefreshRef.current === refreshKey) return;
      refreshTimer = setTimeout(() => {
        if (AppState.currentState === 'active' && connectPhaseRef.current !== 'waitingForApproval' && connectPhaseRef.current !== 'delayed') {
          connectAccessRefreshRef.current = refreshKey;
          void connect().then((result) => {
            if (cancelled || AppState.currentState !== 'active') return;
            if (result.status !== 'connected') { connectAccessRefreshRef.current = ''; refreshTimer = setTimeout(scheduleRefresh, 60_000); }
          });
        }
      }, recover ? 1000 : Math.min(Math.max(remaining - 5 * 60_000, 1000), 2_147_483_647));
    };
    const check = () => {
      const message = getConnectCredentialError(settings.connect, settings.password);
      if (message) {
        if (connectionRef.current.status !== 'error' || connectionRef.current.message !== message) {
          scopeGenerationRef.current += 1;
          serverGenerationRef.current += 1;
          clearProjectState();
          setSendingState({ active: false });
          setConnection({ status: 'error', message, kind: 'auth', checkedAt: Date.now() });
        }
        scheduleRefresh();
        return;
      }
      timer = setTimeout(check, Math.min(Date.parse(settings.connect!.expiresAt) - Date.now(), 2_147_483_647));
    };
    check();
    scheduleRefresh();
    const subscription = AppState.addEventListener('change', (state) => {
      clearTimeout(timer); clearTimeout(refreshTimer);
      if (state === 'active') { check(); scheduleRefresh(); }
    });
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(refreshTimer); subscription.remove(); };
  }, [activationPaused, clearProjectState, connect, connectionRef, isHydrated, scopeGenerationRef, serverGenerationRef, setConnection, setSendingState, settings.connect, settings.password]);

  return { connect, updateSettings, switchConnection, connectSetup, handleStreamAuthFailure };
}
