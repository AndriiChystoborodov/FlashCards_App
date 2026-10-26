import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp, type ApiDeps } from './app.js';
import { isLoopbackAddress } from './loopback.js';

export interface RunningServer {
  app: Express;
  host: string;
  port: number;
  close(): Promise<void>;
}

/** Builds the app and listens on `deps.bindHost` (the host the check used); with the student routes on it also checks the address the socket got. Port 0 picks a free port. */
export async function startServer(deps: ApiDeps, port = 0): Promise<RunningServer> {
  const app = createApp(deps); // throws before anything listens when the host is not allowed
  const listenHost = deps.bindHost.startsWith('[') ? deps.bindHost.slice(1, -1) : deps.bindHost; // Node wants `::1`, not `[::1]`
  const server = app.listen(port, listenHost);
  await new Promise<void>((resolve, reject) => server.once('listening', resolve).once('error', reject));
  const address = (server.address() as AddressInfo).address;
  if (deps.studentRoutesEnabled && !isLoopbackAddress(address)) {
    // `localhost` is resolved by the OS: what matters is the address the socket really got.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`STUDENT_ROUTES_ENABLED=true is allowed only on a loopback address; the server bound to ${address}.`);
  }
  return {
    app,
    host: deps.bindHost,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
