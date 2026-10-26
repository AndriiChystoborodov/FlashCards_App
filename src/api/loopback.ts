/**
 * True only for the loopback names we accept as a bind host: `localhost`, `127.0.0.1`, `::1` (also `[::1]`), in any case, and `localhost.` with
 * its trailing dot. No prefix or range matching: `localhost.evil.com`, `127.0.0.2`, `::ffff:127.0.0.1`, `0.0.0.0`, `::` and `''` are not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1) === '::1';
  if (h === 'localhost.') h = 'localhost'; // the fully qualified form; a dot after an IP literal is not a host
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * The one place that decides whether the unauthenticated student routes (decision 0018) may exist: `createApp` calls it,
 * and `createApp` is the only code that mounts them. Prints the host, never anything else from the configuration.
 */
export function assertStudentRoutesAllowed(studentRoutesEnabled: boolean, bindHost: string): void {
  if (!studentRoutesEnabled || isLoopbackHost(bindHost)) return;
  const shown = /^[A-Za-z0-9.:\[\]_-]{0,255}$/.test(bindHost) ? JSON.stringify(bindHost) : '<unprintable>';
  throw new Error(`STUDENT_ROUTES_ENABLED=true is allowed only when the server binds to a loopback host (localhost, 127.0.0.1, ::1); the bind host is ${shown}.`);
}

/** The address a listening socket really got (`server.address().address`): `::1` or any 127.x.x.x. */
export const isLoopbackAddress = (a: string): boolean => a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);

