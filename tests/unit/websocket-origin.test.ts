import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isWebSocketOriginAllowed } from '../../src/server/websocketOrigin';

function request(origin: string | undefined, host = 'localhost:3000', encrypted = false): IncomingMessage {
  return {
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    rawHeaders: ['Host', host, ...(origin === undefined ? [] : ['Origin', origin])],
    socket: { encrypted },
  } as unknown as IncomingMessage;
}

describe('WebSocket browser origins', () => {
  it.each([
    ['http://localhost:3000', 'localhost:3000', false],
    ['http://192.168.1.10:3000', '192.168.1.10:3000', false],
    ['https://192.168.1.10:3001', '192.168.1.10:3001', true],
    ['https://[::1]:3001', '[::1]:3001', true],
    ['https://darts.example', 'darts.example:443', true],
    ['http://darts.example:80', 'darts.example', false],
    ['https://DARTS.EXAMPLE', 'darts.example', true],
  ] as const)('accepts same-origin %s', (origin, host, tls) => {
    expect(isWebSocketOriginAllowed(request(origin, host, tls), null)).toBe(true);
  });

  it.each([
    'https://localhost:3000', 'http://localhost:3001', 'http://other.example:3000',
    'null', '', '*', 'file://localhost:3000', 'ws://localhost:3000',
    'http://localhost:3000/path', 'http://localhost:3000/', 'http://localhost:3000?x=1',
    'http://localhost:3000#fragment', 'http://user@localhost:3000',
    'http://localhost:3000 http://other.example', 'http://localhost:3000,http://other.example',
    'http://localhost:3000\\other',
  ])('rejects foreign or malformed origin %s', (origin) => {
    expect(isWebSocketOriginAllowed(request(origin), null)).toBe(false);
  });

  it('requires exactly one Origin header', () => {
    const req = request('http://localhost:3000');
    req.rawHeaders.push('oRiGiN', 'http://localhost:3000');
    expect(isWebSocketOriginAllowed(req, null)).toBe(false);
  });

  it('does not derive a trusted origin from forwarded headers', () => {
    const req = request('https://darts.example');
    req.headers.forwarded = 'host=darts.example;proto=https';
    req.headers['x-forwarded-host'] = 'darts.example';
    req.headers['x-forwarded-proto'] = 'https';
    expect(isWebSocketOriginAllowed(req, null)).toBe(false);
    expect(isWebSocketOriginAllowed(req, ['https://darts.example'])).toBe(true);
  });

  it('uses an explicit list instead of adding it to automatic same-origin permission', () => {
    const allowed = ['https://darts.example'];
    expect(isWebSocketOriginAllowed(request('http://localhost:3000'), allowed)).toBe(false);
    expect(isWebSocketOriginAllowed(request('https://darts.example'), allowed)).toBe(true);
    expect(isWebSocketOriginAllowed(request('https://sub.darts.example'), allowed)).toBe(false);
    expect(isWebSocketOriginAllowed(request('https://darts.example:8443'), allowed)).toBe(false);
  });

  it('lets an empty list deny browser origins while retaining clients without Origin', () => {
    expect(isWebSocketOriginAllowed(request('http://localhost:3000'), [])).toBe(false);
    expect(isWebSocketOriginAllowed(request('null'), [])).toBe(false);
    expect(isWebSocketOriginAllowed(request(undefined), [])).toBe(true);
    expect(isWebSocketOriginAllowed(request(undefined), null)).toBe(true);
  });

  it('rejects missing or malformed Host for the automatic policy', () => {
    const req = request('http://localhost:3000');
    delete req.headers.host;
    expect(isWebSocketOriginAllowed(req, null)).toBe(false);
    req.headers.host = 'localhost:3000/';
    expect(isWebSocketOriginAllowed(req, null)).toBe(false);
  });
});
