import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export type RecordedRequest = {
  method: string;
  url: string;
  authorization?: string;
};

export type FakeRelay = {
  /** Origin of the relay-like proxy (`http://127.0.0.1:<port>`). */
  url: string;
  /** Every request the proxy received, in arrival order. */
  requests: RecordedRequest[];
  stop: () => Promise<void>;
};

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address === 'object' && address) {
        const { port } = address;
        probe.close(() => resolve(port));
        return;
      }
      probe.close();
      reject(new Error('Could not reserve a port for the fake OpenCode server.'));
    });
  });
}

async function waitForServer(url: string, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // Server not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fake OpenCode server did not start at ${url}`);
}

/**
 * Starts `tests/fake-opencode/server.mjs` behind a proxy that only accepts
 * `/relay/<hostId>/...` and strips that prefix before forwarding. This models a
 * relay tunnel: an app pointed at `http://127.0.0.1:<port>/relay/abc` must see
 * its path prefix preserved on every request, including the SSE stream.
 */
export async function startFakeRelay(prefix = '/relay/abc'): Promise<FakeRelay> {
  const upstreamPort = await reservePort();
  let child: ChildProcess | undefined;
  const requests: RecordedRequest[] = [];

  const proxy = http.createServer((request, response) => {
    const url = request.url ?? '/';
    requests.push({
      method: request.method ?? 'GET',
      url,
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
    });

    if (url !== prefix && !url.startsWith(`${prefix}/`)) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Relay prefix required' }));
      return;
    }

    const upstream = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      path: url.slice(prefix.length),
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${upstreamPort}` },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    // An aborted SSE reader must also tear down the upstream stream.
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });

  const port = await new Promise<number>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      const address = proxy.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('Could not read the relay proxy port.'));
    });
  });

  child = spawn(process.execPath, [path.join(process.cwd(), 'tests/fake-opencode/server.mjs')], {
    env: { ...process.env, FAKE_OPENCODE_PORT: String(upstreamPort) },
    stdio: 'ignore',
  });

  try {
    await waitForServer(`http://127.0.0.1:${upstreamPort}/api/info`);
  } catch (error) {
    child.kill('SIGTERM');
    proxy.close();
    throw error;
  }

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: async () => {
      child?.kill('SIGTERM');
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}
