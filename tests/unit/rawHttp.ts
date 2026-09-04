import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { ClientRequestHandler } from '../../src/server/staticServing';

/**
 * A real server on a real port, driven by request lines written byte for byte.
 *
 * Not ceremony: **the request line is often the thing under test.** A client library normalises
 * `/../SECRET.txt` away before it ever leaves the process, and that is exactly the request the
 * server has to be shown refusing. Nothing here knows how the handler is built, which is what lets
 * these tests outlive whichever library is serving.
 */

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Probe {
  /** Sends `requestLine` verbatim, e.g. `GET /../SECRET.txt HTTP/1.1`. */
  send(requestLine: string, extraHeaders?: Record<string, string>): Promise<RawResponse>;
  close(): Promise<void>;
}

/** Puts a client handler behind a socket, answering 404 to whatever it declines. */
export async function probe(handler: ClientRequestHandler): Promise<Probe> {
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (handled) return;
      res.statusCode = 404;
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  return {
    send(requestLine, extraHeaders = {}) {
      return new Promise<RawResponse>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          const extra = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('');
          socket.write(`${requestLine}\r\nHost: localhost\r\n${extra}Connection: close\r\n\r\n`);
        });

        let raw = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => { raw += chunk; });
        socket.on('error', reject);
        socket.on('end', () => {
          const [head, ...rest] = raw.split('\r\n\r\n');
          const [statusLine, ...headerLines] = head.split('\r\n');
          const headers: Record<string, string> = {};
          for (const line of headerLines) {
            const at = line.indexOf(':');
            if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
          }
          resolve({
            status: Number(statusLine.split(' ')[1]),
            headers,
            body: rest.join('\r\n\r\n'),
          });
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
