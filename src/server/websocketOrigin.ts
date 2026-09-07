import type { IncomingMessage } from 'node:http';

/** Parse an HTTP(S) origin only: no credentials, path, query, fragment or opaque origin. */
export function parseWebOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s@,]+$/i.test(value)) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Browser admission policy; Origin is not authentication for non-browser clients. */
export function isWebSocketOriginAllowed(req: IncomingMessage, allowedOrigins: readonly string[] | null): boolean {
  // Native clients need not send Origin. Browsers send it, including the literal "null" for an
  // opaque origin; that value is invalid and must not be treated as an absent header.
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'origin').length !== 1) return false;
  const parsed = parseWebOrigin(origin);
  if (!parsed) return false;
  if (allowedOrigins !== null) return allowedOrigins.includes(parsed);

  // Default to the origin serving this request. Forwarded headers are not trusted: TLS proxies
  // must configure the external browser origin explicitly instead of letting clients name it.
  const scheme = 'encrypted' in req.socket && req.socket.encrypted === true ? 'https' : 'http';
  const host = req.headers.host;
  return typeof host === 'string' && parsed === parseWebOrigin(`${scheme}://${host}`);
}
