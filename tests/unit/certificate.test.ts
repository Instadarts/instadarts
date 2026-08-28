import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { createServer } from 'node:https';
import { get } from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The certificate is built by hand, in DER, because Node can generate keys but cannot make an X.509
 * certificate. That means nothing else validates the bytes, so these tests do: every structural
 * claim is checked by parsing the result back, and the last of them proves the only thing that
 * really matters — that a TLS client completes a handshake against it.
 */

const dirs: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'instadarts-cert-'));
  dirs.push(dir);
  return dir;
}

/** A fresh module per case: the certificate module reads CONFIG once, at import. */
async function load(dir: string, https: Record<string, unknown> = {}) {
  const settings = join(dir, 'instadarts.config.json');
  writeFileSync(settings, JSON.stringify({ server: { https } }));
  vi.resetModules();
  vi.stubEnv('INSTADARTS_CONFIG', settings);
  return import('../../src/server/certificate');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the certificate the server makes for itself', () => {
  it('covers every address it was given, plus the loopbacks a browser uses here', async () => {
    const dir = sandbox();
    const { resolveCertificate } = await load(dir);

    const resolved = resolveCertificate(['192.168.1.40', 'fd00::40']);
    expect(resolved.source).toBe('generated');

    const parsed = new X509Certificate(resolved.cert);
    const sans = parsed.subjectAltName ?? '';
    expect(sans).toContain('IP Address:192.168.1.40');
    expect(sans).toContain('IP Address:127.0.0.1');
    expect(sans).toContain('DNS:localhost');
    // IPv6 comes back expanded, so match on the parsed form rather than the text handed in.
    expect(sans.toLowerCase()).toContain('fd00:0:0:0:0:0:0:40');
  });

  it('is a self-signed server certificate a TLS client will actually complete a handshake against', async () => {
    const dir = sandbox();
    const { resolveCertificate } = await load(dir);
    const { cert, key } = resolveCertificate(['192.168.1.40']);

    const parsed = new X509Certificate(cert);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.ca).toBe(false);
    // The key has to belong to the certificate, or the handshake below is the first thing to say so.
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true);

    const server = createServer({ cert, key }, (_req, res) => res.end('over tls'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };

    const body = await new Promise<string>((done, fail) => {
      get({ host: '127.0.0.1', port, rejectUnauthorized: false }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => done(text));
      }).on('error', fail);
    });
    server.close();

    expect(body).toBe('over tls');
  });

  it('keeps the one it made, so a browser is not asked to trust a new one after every restart', async () => {
    const dir = sandbox();
    const { resolveCertificate } = await load(dir);

    const first = resolveCertificate(['192.168.1.40']);
    expect(first.source).toBe('generated');

    const again = resolveCertificate(['192.168.1.40']);
    expect(again.source).toBe('reused');
    expect(new X509Certificate(again.cert).serialNumber).toBe(new X509Certificate(first.cert).serialNumber);
  });

  it('makes a new one when the machine has an address the old one does not name', async () => {
    const dir = sandbox();
    const { resolveCertificate } = await load(dir);

    const first = resolveCertificate(['192.168.1.40']);
    // What a new DHCP lease looks like from here.
    const second = resolveCertificate(['192.168.1.77']);

    expect(second.source).toBe('generated');
    expect(new X509Certificate(second.cert).serialNumber)
      .not.toBe(new X509Certificate(first.cert).serialNumber);
    expect(new X509Certificate(second.cert).subjectAltName).toContain('IP Address:192.168.1.77');
  });

  it('does not regenerate merely because an address went away', async () => {
    const dir = sandbox();
    const { resolveCertificate } = await load(dir);

    resolveCertificate(['192.168.1.40', '10.0.0.5']);
    // An interface disappearing leaves a certificate that still covers everything still present.
    expect(resolveCertificate(['192.168.1.40']).source).toBe('reused');
  });
});

describe('a certificate the deployment supplies', () => {
  it('is used as given, and nothing is generated beside it', async () => {
    const dir = sandbox();
    const own = await load(dir);
    const made = own.resolveCertificate(['192.168.1.40']);
    const certFile = join(dir, 'mine.pem');
    const keyFile = join(dir, 'mine.key');
    writeFileSync(certFile, made.cert);
    writeFileSync(keyFile, made.key);
    rmSync(join(dir, 'instadarts-selfsigned.pem'));
    rmSync(join(dir, 'instadarts-selfsigned.key'));

    const { resolveCertificate } = await load(dir, { cert: 'mine.pem', key: 'mine.key' });
    const resolved = resolveCertificate(['10.0.0.1']);

    expect(resolved.source).toBe('configured');
    expect(resolved.cert).toBe(readFileSync(certFile, 'utf8'));
    // The addresses are not its business: a real certificate names what its issuer said it names.
    expect(() => readFileSync(join(dir, 'instadarts-selfsigned.pem'))).toThrow();
  });

  it('stops the server when it is named and cannot be read', async () => {
    const dir = sandbox();
    const { resolveCertificate } = await load(dir, { cert: 'absent.pem', key: 'absent.key' });
    expect(() => resolveCertificate(['192.168.1.40'])).toThrow(/absent\.pem.*could not be read/s);
  });

  it('refuses half of a pair, which is a mistake rather than a preference', async () => {
    const dir = sandbox();
    const { resolveCertificate } = await load(dir, { cert: 'mine.pem' });
    expect(() => resolveCertificate(['192.168.1.40'])).toThrow(/both cert and key/);
  });
});
