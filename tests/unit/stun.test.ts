import { describe, it, expect, afterEach } from 'vitest';
import { createSocket, type Socket } from 'dgram';
import { randomBytes } from 'crypto';
import { startStunServer, type StunServer } from '../../src/server/stun';

/**
 * The STUN server.
 *
 * **The decoder below is written from RFC 5389 rather than imported**, which is the entire point of
 * these tests. Checking an encoder against its own decoder proves the two agree and nothing else; a
 * browser will not be reading our decoder. So the reply is taken apart here by hand — header, magic
 * cookie, attribute walk, XOR — and every field is checked against what the sending socket knows
 * about itself independently.
 *
 * What is being pinned is that a peer is told **its own address**, correctly masked, in the family
 * it actually arrived on. Everything else about this feature is downstream of that one answer.
 */

const MAGIC_COOKIE = 0x2112a442;
const COOKIE_BYTES = Buffer.alloc(4);
COOKIE_BYTES.writeUInt32BE(MAGIC_COOKIE);

/** A Binding Request: a header, no attributes, and a transaction id to recognise the reply by. */
function bindingRequest(): { message: Buffer; transaction: Buffer } {
  const transaction = randomBytes(12);
  const message = Buffer.alloc(20);
  message.writeUInt16BE(0x0001, 0); // Binding Request
  message.writeUInt16BE(0, 2); // no attributes
  message.writeUInt32BE(MAGIC_COOKIE, 4);
  transaction.copy(message, 8);
  return { message, transaction };
}

interface Mapped {
  family: number;
  bytes: Buffer;
  port: number;
}

/** RFC 5389 §6 and §15.2, read out longhand. Throws on anything it does not recognise. */
function decodeBindingSuccess(reply: Buffer, transaction: Buffer): Mapped {
  expect(reply.readUInt16BE(0)).toBe(0x0101); // Binding Success Response
  expect(reply.readUInt32BE(4)).toBe(MAGIC_COOKIE);
  expect(reply.subarray(8, 20).equals(transaction)).toBe(true);
  // The length counts the attributes and not the twenty-byte header.
  expect(reply.readUInt16BE(2)).toBe(reply.length - 20);

  let offset = 20;
  while (offset < reply.length) {
    const type = reply.readUInt16BE(offset);
    const length = reply.readUInt16BE(offset + 2);
    const value = reply.subarray(offset + 4, offset + 4 + length);

    if (type === 0x0020) {
      // XOR-MAPPED-ADDRESS: a reserved byte, the family, the port masked with the cookie's top half,
      // then the address masked with the cookie — extended by the transaction id for IPv6, which is
      // what makes the mask as long as the sixteen bytes it has to cover.
      expect(value.readUInt8(0)).toBe(0);
      const family = value.readUInt8(1);
      const key = family === 0x01 ? COOKIE_BYTES : Buffer.concat([COOKIE_BYTES, transaction]);
      const raw = value.subarray(4);
      return {
        family,
        port: value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16),
        bytes: Buffer.from(raw.map((byte, i) => byte ^ key[i])),
      };
    }
    offset += 4 + length + ((4 - (length % 4)) % 4); // attributes are padded to a multiple of four
  }
  throw new Error('no XOR-MAPPED-ADDRESS in the reply');
}

const open: { servers: StunServer[]; sockets: Socket[] } = { servers: [], sockets: [] };

afterEach(() => {
  for (const server of open.servers) server.close();
  for (const socket of open.sockets) socket.close();
  open.servers = [];
  open.sockets = [];
});

async function serve(): Promise<StunServer> {
  const server = await startStunServer(0); // an ephemeral port, so tests never collide
  open.servers.push(server);
  expect(server.problem).toBe(null);
  expect(server.port).not.toBe(null);
  return server;
}

/** Send one packet from a fresh socket and hand back the reply, or null if none came. */
function exchange(
  type: 'udp4' | 'udp6',
  host: string,
  port: number,
  message: Buffer,
): Promise<{ reply: Buffer | null; from: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(type);
    open.sockets.push(socket);
    socket.on('error', reject);
    // Bounded rather than open-ended: a test that hangs on a missing UDP reply says far less than
    // one that fails, and "no reply" is itself an expected outcome below.
    const timer = setTimeout(() => resolve({ reply: null, from: socket }), 500);
    socket.on('message', (reply) => {
      clearTimeout(timer);
      resolve({ reply, from: socket });
    });
    socket.bind(0, () => socket.send(message, port, host));
  });
}

describe('answering a Binding Request', () => {
  it('tells an IPv4 peer its own address and port', async () => {
    const server = await serve();
    const { message, transaction } = bindingRequest();
    const { reply, from } = await exchange('udp4', '127.0.0.1', server.port!, message);

    expect(reply).not.toBe(null);
    const mapped = decodeBindingSuccess(reply!, transaction);

    // A dual-stack socket sees this peer as ::ffff:127.0.0.1. Reporting that back as an IPv6
    // address would describe a path the peer does not have, so the four bytes are what must come
    // out — family 0x01 and nothing wider.
    expect(mapped.family).toBe(0x01);
    expect([...mapped.bytes]).toEqual([127, 0, 0, 1]);
    expect(mapped.port).toBe(from.address().port);
  });

  it('tells an IPv6 peer its own address and port', async () => {
    const server = await serve();
    const { message, transaction } = bindingRequest();
    const { reply, from } = await exchange('udp6', '::1', server.port!, message);

    expect(reply).not.toBe(null);
    const mapped = decodeBindingSuccess(reply!, transaction);

    expect(mapped.family).toBe(0x02);
    expect([...mapped.bytes]).toEqual([...Array<number>(15).fill(0), 1]);
    expect(mapped.port).toBe(from.address().port);
  });

  it('gives each request its own transaction id back', async () => {
    const server = await serve();
    const first = bindingRequest();
    const second = bindingRequest();

    const a = await exchange('udp4', '127.0.0.1', server.port!, first.message);
    const b = await exchange('udp4', '127.0.0.1', server.port!, second.message);

    // Decoding each against the *other's* id would be the failure worth catching: a server that
    // echoed a fixed id would still look right in every test above.
    expect(a.reply!.subarray(8, 20).equals(first.transaction)).toBe(true);
    expect(b.reply!.subarray(8, 20).equals(second.transaction)).toBe(true);
    expect(first.transaction.equals(second.transaction)).toBe(false);
  });
});

describe('what it refuses to answer', () => {
  /**
   * Silence rather than an error, in every case.
   *
   * This is a port on the open internet: it receives scanners and stray traffic, and a server that
   * replies to anything at all is a server somebody can point at a third party. A reply is only ever
   * sent to something that proved it meant to talk STUN.
   */
  it.each([
    ['a packet too short to be a header', Buffer.alloc(8)],
    [
      'the wrong magic cookie',
      (() => {
        const { message } = bindingRequest();
        message.writeUInt32BE(0xdeadbeef, 4);
        return message;
      })(),
    ],
    [
      'a message that is not a Binding Request',
      (() => {
        const { message } = bindingRequest();
        message.writeUInt16BE(0x0003, 0); // Allocate, which is TURN and not ours to answer
        return message;
      })(),
    ],
    [
      'a length that disagrees with the packet',
      (() => {
        const { message } = bindingRequest();
        message.writeUInt16BE(8, 2); // claims eight bytes of attributes it does not carry
        return message;
      })(),
    ],
  ])('says nothing to %s', async (_what, message) => {
    const server = await serve();
    const { reply } = await exchange('udp4', '127.0.0.1', server.port!, message);
    expect(reply).toBe(null);
  });
});

describe('when it cannot listen', () => {
  it('reports the problem instead of throwing', async () => {
    const first = await serve();

    // The same port twice. Nothing here should escape as an exception: a UDP port that is taken is
    // not a reason for the process to stop serving darts.
    const second = await startStunServer(first.port!);
    open.servers.push(second);

    expect(second.port).toBe(null);
    expect(second.problem).toMatch(/EADDRINUSE/);
  });
});
