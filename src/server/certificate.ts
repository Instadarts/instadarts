import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';
import { CONFIG, CONFIG_PATH } from './config';

/**
 * The certificate the HTTPS listener presents.
 *
 * Two ways to get one, and the settings file decides which by naming a certificate or not:
 *
 *   · **A deployment's own.** `server.https.cert` and `key` are paths, and that is the end of it —
 *     nothing below runs, nothing is generated, nothing is written.
 *   · **One this server makes.** The point is a phone on the LAN: `getUserMedia` needs a secure
 *     context, so without TLS the camera — the scoring device's whole job — is unavailable behind
 *     a browser flag. A self-signed certificate does not remove the warning a browser shows, but it
 *     does make the warning the only obstacle, and one a person can get past in two taps.
 *
 * The generated certificate is kept on disk rather than made fresh each boot. A browser remembers
 * the exception per certificate, so regenerating would ask every device to accept it again after
 * every restart.
 *
 * Node can generate keys but has no api for *making* an X.509 certificate — `X509Certificate` only
 * reads them. So the structure below is built by hand, in DER, which is why this file exists at all
 * and why it is the only place in the tree that knows what a certificate is made of. It buys the
 * property the release archive depends on: no dependency to carry, and none to license.
 */

interface Certificate {
  key: string;
  cert: string;
}

/** How long a generated certificate is good for. Long enough not to be a chore, short enough to rotate. */
const LIFETIME_DAYS = 825;

/** Regenerate this far before expiry, so a long-running server never presents a dead certificate. */
const RENEW_WITHIN_DAYS = 30;

/** Always in the certificate, whatever the interfaces say: this machine reaching itself. */
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

const FILE_NAMES = { cert: 'instadarts-selfsigned.pem', key: 'instadarts-selfsigned.key' };

// ── DER, only as much of it as one self-signed certificate needs ─────────────────────────────────
//
// Every value is a tag, a length and a body. The length is short-form below 128 and otherwise a
// count of the bytes that hold it, which is the only part of DER that is not simply nesting.

const derLength = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const setOf = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const integer = (body: Buffer): Buffer => tlv(0x02, body);

/**
 * A positive INTEGER, minimally encoded — which DER insists on and is easy to get wrong.
 *
 * Integers here are signed, so a leading byte of 0x80 or above reads as negative and needs a zero
 * in front of it. That zero is *only* legal when it is doing that job: padding a value that would
 * already read as positive is rejected outright, which for a random serial happens about half the
 * time and is the kind of bug that ships looking fine.
 */
const positiveInteger = (bytes: Buffer): Buffer => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  return integer(trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};
const bitString = (body: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), body]));
const octetString = (body: Buffer): Buffer => tlv(0x04, body);
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value));

/** `YYMMDDHHMMSSZ`. Good until 2049, which no certificate this makes will outlive. */
const utcTime = (at: Date): Buffer =>
  tlv(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

/** A tagged wrapper: `[n]`, holding either a nested value or a bare body. */
const context = (n: number, constructed: boolean, ...parts: Buffer[]): Buffer =>
  tlv((constructed ? 0xa0 : 0x80) | n, ...parts);

/** Dotted decimal to DER: first two arcs share a byte, the rest are base-128 with a continuation bit. */
const objectId = (dotted: string): Buffer => {
  const arcs = dotted.split('.').map(Number);
  const bytes = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [];
    for (let v = arc; ; v >>>= 7) {
      chunk.unshift(v & 0x7f);
      if (v < 0x80) break;
    }
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i]! |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
};

const OID = {
  commonName: '2.5.4.3',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extendedKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const distinguishedName = (commonName: string): Buffer =>
  sequence(setOf(sequence(objectId(OID.commonName), utf8String(commonName))));

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  sequence(objectId(id), ...(critical ? [boolean(true)] : []), octetString(value));

/** IPv4 to its four bytes, IPv6 to its sixteen. A SAN holds the address itself, not its text. */
function ipBytes(address: string): Buffer | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const parts = address.split('.').map(Number);
    return parts.every((p) => p >= 0 && p <= 255) ? Buffer.from(parts) : null;
  }
  if (!address.includes(':')) return null;

  // `::` stands for however many zero groups are needed to reach eight.
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  if (tail === undefined && left.length !== 8) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const out = Buffer.alloc(16);
  for (const [i, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    out.writeUInt16BE(parseInt(group, 16), i * 2);
  }
  return out;
}

/** A name a client may have typed: an ip if it parses as one, a hostname otherwise. */
const generalName = (address: string): Buffer => {
  const ip = ipBytes(address);
  return ip ? context(7, false, ip) : context(2, false, Buffer.from(address));
};

/** Every certificate this makes covers these, in this order. */
const subjectNames = (addresses: string[]): string[] => [...new Set([...addresses, ...LOOPBACK])];

function generate(addresses: string[]): Certificate {
  const { publicKey: spki, privateKey: key } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const algorithm = sequence(objectId(OID.ecdsaWithSha256));
  const name = distinguishedName('InstaDarts');
  const from = new Date();
  const until = new Date(from.getTime() + LIFETIME_DAYS * 24 * 60 * 60 * 1000);

  const tbs = sequence(
    context(0, true, integer(Buffer.from([2]))), // v3, which is what having extensions requires
    positiveInteger(randomBytes(8)),
    algorithm,
    name,
    sequence(utcTime(from), utcTime(until)),
    name, // self-signed: the issuer and the subject are the same
    spki,
    context(3, true, sequence(
      extension(OID.basicConstraints, true, sequence()), // an empty SEQUENCE is cA = false
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([5, 0xa0]))), // digitalSignature, keyEncipherment
      extension(OID.extendedKeyUsage, false, sequence(objectId(OID.serverAuth))),
      extension(OID.subjectAltName, false, sequence(...subjectNames(addresses).map(generalName))),
    )),
  );

  const der = sequence(tbs, algorithm, bitString(sign('sha256', tbs, key)));
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return { key, cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n` };
}

/**
 * Whether a certificate already on disk can go on being used.
 *
 * Two ways it cannot. It can be near enough to expiry to be worth replacing now rather than
 * mid-match — and it can have been made for addresses this machine no longer has, which is what a
 * new DHCP lease looks like from here. A certificate that does not name the address a phone is
 * about to type is one that phone will not accept, so a missing name is a reason to start again.
 */
function stillCovers(cert: string, addresses: string[]): boolean {
  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(cert);
  } catch {
    return false;
  }

  const renewAt = new Date(Date.now() + RENEW_WITHIN_DAYS * 24 * 60 * 60 * 1000);
  if (new Date(parsed.validTo) < renewAt) return false;

  // `subjectAltName` is a rendered list — `DNS:localhost, IP Address:127.0.0.1` — so compare on the
  // values rather than trying to reproduce its formatting. IPv6 comes back expanded.
  const present = new Set(
    (parsed.subjectAltName ?? '').split(',').map((entry) => entry.split(':').slice(1).join(':').trim()),
  );
  const covered = (address: string): boolean => {
    if (present.has(address)) return true;
    const wanted = ipBytes(address);
    if (!wanted) return false;
    return [...present].some((candidate) => wanted.equals(ipBytes(candidate) ?? Buffer.alloc(0)));
  };
  return subjectNames(addresses).every(covered);
}

/** Where a generated certificate is kept: beside the settings it belongs to. */
function cacheDir(): string {
  if (CONFIG_PATH) return dirname(CONFIG_PATH);
  return process.env.INSTADARTS_DIR ?? process.cwd();
}

/** A configured path, read relative to the settings file rather than to wherever we were started. */
function configured(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(CONFIG_PATH ? dirname(CONFIG_PATH) : process.cwd(), path);
}

/**
 * What this run should present, and how it came by it.
 *
 * `source` is for the startup report: a deployment that thinks it named a certificate and is
 * quietly being served a generated one has a problem worth being told about before a browser tells
 * it instead.
 */
export interface ResolvedCertificate extends Certificate {
  source: 'configured' | 'generated' | 'reused';
  /** Set when a generated certificate could not be written down, so it will not survive a restart. */
  notPersisted?: string;
  /**
   * What a generated certificate was made valid for, to be reported at startup. Empty for a
   * supplied one: what that names is between the deployment and whoever issued it.
   */
  names: string[];
}

export function resolveCertificate(addresses: string[]): ResolvedCertificate {
  const { cert: certPath, key: keyPath } = CONFIG.server.https;

  // Named, so it is theirs and no part of the rest of this file applies. A path that cannot be read
  // is fatal by the same rule the settings file follows: a deployment that believes it is
  // configured and is not is worse than one that will not start.
  if (certPath || keyPath) {
    if (!certPath || !keyPath) {
      throw new Error('server.https needs both cert and key, or neither');
    }
    const read = (path: string, what: string): string => {
      try {
        return readFileSync(configured(path), 'utf8');
      } catch (err) {
        throw new Error(`server.https.${what} "${path}" could not be read: ${(err as Error).message}`);
      }
    };
    const cert = read(certPath, 'cert');
    return { cert, key: read(keyPath, 'key'), source: 'configured', names: [] };
  }

  const dir = cacheDir();
  const certFile = resolve(dir, FILE_NAMES.cert);
  const keyFile = resolve(dir, FILE_NAMES.key);
  const names = subjectNames(addresses);

  try {
    const cert = readFileSync(certFile, 'utf8');
    const key = readFileSync(keyFile, 'utf8');
    if (stillCovers(cert, addresses)) return { cert, key, source: 'reused', names };
  } catch {
    // No usable pair on disk. Making one is the normal path, not a failure.
  }

  const made = generate(addresses);
  try {
    writeFileSync(certFile, made.cert);
    writeFileSync(keyFile, made.key, { mode: 0o600 });
  } catch (err) {
    return { ...made, source: 'generated', names, notPersisted: (err as Error).message };
  }
  return { ...made, source: 'generated', names };
}
