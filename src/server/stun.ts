// A STUN server, which is a smaller thing than its reputation suggests.
//
// One UDP socket, one question, one answer: a peer asks "what address do you see me at", and the
// reply is that address. That is the whole of what WebRTC needs from a STUN server — it is how a
// browser learns its *server-reflexive* candidate, the public address its NAT gave it, which it can
// then offer to a peer that could never have guessed it from the LAN address it sees locally.
//
// **This is not TURN.** Nothing is relayed and no media passes through here; the reply is thirty-two
// bytes and the conversation is over. Two peers that cannot reach each other even knowing their
// public addresses — symmetric NAT on both ends — are not helped by this, and are not meant to be.
//
// ## Why carry our own
//
// The alternative is naming somebody else's, which in practice means Google's, and that hands the
// address of every player to a third party in order to make an optional feature work. A deployment
// that already has a public address can answer this question about its own users itself.
//
// ## What it needs to be useful
//
// A **publicly reachable UDP port**, which is the one part of a deployment that a reverse proxy does
// not provide: proxies forward TCP, and this is not TCP. On a LAN it answers with the address the
// client already knew, and the browser discards the redundant candidate — harmless, and pointless,
// which is the right way round for something on by default.

import { createSocket, type Socket } from 'dgram';
import { isIPv4 } from 'net';

/** The four bytes that make a STUN message recognisable, and half the XOR key. RFC 5389 §6. */
const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;
const HEADER_BYTES = 20;
/** Type, cookie and transaction id are fixed; everything after is attributes. */
const TRANSACTION_BYTES = 12;

const COOKIE_BYTES = Buffer.alloc(4);
COOKIE_BYTES.writeUInt32BE(MAGIC_COOKIE);

export interface StunServer {
  /**
   * The port it is answering on, or null if it never bound.
   *
   * Read rather than assumed because a caller may ask for port 0 — the tests do — and because the
   * null case is the one that must not be advertised to clients.
   */
  readonly port: number | null;
  /** Why it did not bind, for whoever is starting the server to hear about. */
  readonly problem: string | null;
  close(): void;
}

/**
 * An address as `XOR-MAPPED-ADDRESS` wants it: a family and the raw bytes.
 *
 * A dual-stack socket reports an IPv4 peer as `::ffff:1.2.3.4`, and answering that peer with an IPv6
 * family would describe a path it does not have. So the mapped form is unwrapped back to the four
 * bytes it stands for rather than being passed on as sixteen.
 */
function mapped(address: string): { family: 1 | 2; bytes: Buffer } | null {
  const text = address.split('%')[0]; // a link-local address carries a zone id we have no use for
  const v4 = isIPv4(text) ? text : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)?.[1];
  if (v4) return { family: 1, bytes: Buffer.from(v4.split('.').map(Number)) };
  const bytes = ipv6Bytes(text);
  return bytes ? { family: 2, bytes } : null;
}

/** Sixteen bytes from a textual IPv6 address, or null if it is not one. */
function ipv6Bytes(text: string): Buffer | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      // A trailing dotted quad — `64:ff9b::1.2.3.4` — is two groups rather than one.
      if (isIPv4(group)) {
        const [a, b, c, d] = group.split('.').map(Number);
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;

  const missing = 8 - head.length - tail.length;
  // `::` stands for one or more zero groups; without it the address has to be complete already.
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const all = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  if (all.length !== 8) return null;

  const bytes = Buffer.alloc(16);
  all.forEach((group, i) => bytes.writeUInt16BE(group, i * 2));
  return bytes;
}

/**
 * The answer to one Binding Request.
 *
 * The XOR is not obfuscation and not security: it exists because some NATs rewrite anything in a
 * packet body that looks like an address they know, and would have corrupted the very answer being
 * sent. Masking it past recognition is what gets it through intact.
 */
function bindingSuccess(transaction: Buffer, port: number, address: string): Buffer | null {
  const peer = mapped(address);
  if (!peer) return null;

  const value = Buffer.alloc(4 + peer.bytes.length);
  value.writeUInt8(0, 0); // reserved
  value.writeUInt8(peer.family, 1);
  value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);

  // IPv4 is masked with the cookie; IPv6 with the cookie followed by the transaction id, which is
  // exactly as long as the address it has to cover.
  const key = peer.family === 1 ? COOKIE_BYTES : Buffer.concat([COOKIE_BYTES, transaction]);
  for (let i = 0; i < peer.bytes.length; i++) value.writeUInt8(peer.bytes[i] ^ key[i], 4 + i);

  const message = Buffer.alloc(HEADER_BYTES + 4 + value.length);
  message.writeUInt16BE(BINDING_SUCCESS, 0);
  message.writeUInt16BE(4 + value.length, 2); // the attributes' length, header excluded
  message.writeUInt32BE(MAGIC_COOKIE, 4);
  transaction.copy(message, 8);
  message.writeUInt16BE(XOR_MAPPED_ADDRESS, HEADER_BYTES);
  message.writeUInt16BE(value.length, HEADER_BYTES + 2);
  value.copy(message, HEADER_BYTES + 4);
  return message;
}

/**
 * Whether this is a Binding Request and not something else that arrived at an open UDP port.
 *
 * A port on the public internet receives scanners, stray packets and the occasional deliberate
 * probe. Every one of the three checks has to pass before anything is sent back, and a packet that
 * fails is dropped in silence rather than answered with an error — an error would be a reply, and
 * replying to unrecognised traffic is how a small server becomes somebody's amplifier.
 */
function isBindingRequest(msg: Buffer): boolean {
  return (
    msg.length >= HEADER_BYTES &&
    msg.readUInt16BE(0) === BINDING_REQUEST &&
    msg.readUInt32BE(4) === MAGIC_COOKIE &&
    msg.readUInt16BE(2) === msg.length - HEADER_BYTES
  );
}

/**
 * Start answering on `port`, or report why not.
 *
 * Never throws and never brings the process down with it: this is an optional part of an optional
 * feature, and a deployment whose UDP port is taken should still serve darts.
 *
 * Bound on `udp6` with dual-stack on, so one socket answers IPv4 and IPv6 peers alike. A host with
 * IPv6 switched off entirely refuses that, which is the one case worth a second attempt.
 */
export async function startStunServer(port: number): Promise<StunServer> {
  const attempt = (type: 'udp6' | 'udp4'): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = type === 'udp6' ? createSocket({ type, ipv6Only: false }) : createSocket({ type });
      const failed = (err: Error) => {
        socket.close();
        reject(err);
      };
      socket.once('error', failed);
      socket.bind(port, () => {
        socket.off('error', failed);
        resolve(socket);
      });
    });

  let socket: Socket;
  try {
    socket = await attempt('udp6').catch((err: any) => {
      // If the port is already in use or access is denied, trying udp4 won't help (and on Windows,
      // an IPv4 bind can succeed even when an IPv6 dual-stack socket already owns the port).
      // Only fall back to udp4 if IPv6 itself is unavailable or unsupported on the host.
      if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES' || err?.code === 'EPERM') {
        throw err;
      }
      return attempt('udp4');
    });
  } catch (err) {
    return { port: null, problem: (err as Error).message, close: () => {} };
  }

  // Past binding, a socket error is not a reason to stop serving darts. Losing the socket costs the
  // reflexive candidate and nothing else, so it is noted and the process carries on.
  socket.on('error', () => socket.close());

  socket.on('message', (msg, rinfo) => {
    if (!isBindingRequest(msg)) return;
    const reply = bindingSuccess(msg.subarray(8, 8 + TRANSACTION_BYTES), rinfo.port, rinfo.address);
    if (reply) socket.send(reply, rinfo.port, rinfo.address);
  });

  return {
    port: socket.address().port,
    problem: null,
    close: () => socket.close(),
  };
}
