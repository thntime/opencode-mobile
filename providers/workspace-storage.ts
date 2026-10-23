import { withoutConnectionPassword } from '@/lib/connection-password';
import { getConnectionUiScope } from '@/lib/connection-scope';
import { isValidServerUrl, type OpencodeConnectionSettings } from '@/lib/opencode/client';
import { parseConnectionSettings, parseChatPreferences } from '@/providers/persisted-preferences';
import type { ConnectionRecord, WorkspaceTarget } from '@/providers/workspace-types';

export const WORKSPACES_STORAGE_KEY = 'opencode-mobile.workspaces';
export type StoredConnection = Pick<ConnectionRecord, 'id' | 'name' | 'enabled' | 'preferences' | 'projects'> & { settings: Omit<OpencodeConnectionSettings, 'password'> };
export type StoredWorkspaces = { version: 1; connections: StoredConnection[]; focus?: WorkspaceTarget };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseWorkspaces(raw: string): StoredWorkspaces {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > 50) throw new Error('Invalid workspace registry.');
  const seen = new Set<string>();
  const connections: StoredConnection[] = [];
  for (const item of value.connections) {
    try {
      connections.push(parseWorkspaceEntry(item, seen));
    } catch {
      // One corrupt entry must not invalidate the rest of the registry: the
      // user would otherwise lose every saved connection on the next launch.
    }
  }
  // Nothing usable is the existing "registry is unusable" case: let the
  // provider fall back to its in-memory settings instead of persisting an
  // empty registry over the unreadable one.
  if (!connections.length && value.connections.length) throw new Error('Invalid workspace registry.');
  let focus: WorkspaceTarget | undefined;
  if (value.focus !== undefined && object(value.focus) && typeof value.focus.connectionId === 'string' && typeof value.focus.projectPath === 'string') {
    const selection = { connectionId: value.focus.connectionId, projectPath: value.focus.projectPath };
    const entry = connections.find((candidate) => candidate.id === selection.connectionId);
    if (entry) focus = { connectionId: selection.connectionId, projectPath: entry.projects.includes(selection.projectPath) ? selection.projectPath : entry.projects[0] };
  }
  return { version: 1, connections, focus };
}

function parseWorkspaceEntry(item: unknown, seen: Set<string>): StoredConnection {
  if (!object(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.enabled !== 'boolean'
    || !object(item.settings) || 'password' in item.settings || !object(item.preferences) || !Array.isArray(item.projects)
    || !item.projects.length || item.projects.length > 100 || !item.projects.every((path) => typeof path === 'string')) throw new Error('Invalid saved connection.');
  const settings = parseConnectionSettings(JSON.stringify(item.settings));
  if (typeof settings.username !== 'string' || seen.has(item.id)) throw new Error('Invalid connection identity.');
  // Relay sign-in entries legitimately carry no `serverUrl` until a host is
  // chosen; their stable identity is the Relay account. Every other entry still
  // needs a valid direct URL.
  const relayPending = Boolean(settings.relay && !settings.serverUrl);
  if (!relayPending && (!settings.serverUrl || !isValidServerUrl(settings.serverUrl))) throw new Error('Invalid connection identity.');
  if (settings.serverUrl && !isValidServerUrl(settings.serverUrl)) throw new Error('Invalid connection identity.');
  if (getConnectionUiScope({ ...settings, serverUrl: settings.serverUrl ?? '', username: settings.username }) !== item.id) throw new Error('Invalid connection identity.');
  seen.add(item.id);
  return { id: item.id, name: item.name, enabled: item.enabled, settings: { ...settings, serverUrl: settings.serverUrl ?? '', username: settings.username, directory: '' },
    preferences: parseChatPreferences(JSON.stringify(item.preferences)), projects: [...new Set(item.projects as string[])] };
}
export function serializeWorkspaces(connections: ConnectionRecord[], focus?: WorkspaceTarget) {
  return JSON.stringify({ version: 1, connections: connections.map(({ events, settings, ...entry }) => ({ ...entry, settings: withoutConnectionPassword(settings) })), focus });
}
