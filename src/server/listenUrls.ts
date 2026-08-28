import { networkInterfaces } from 'node:os';

interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

type InterfaceTable = Record<string, readonly InterfaceAddress[] | undefined>;

/** Sorts 192.168.1.9 before 192.168.1.10, which comparing them as strings does not. */
const octetKey = (address: string): number =>
  address.split('.').reduce((key, part) => key * 256 + Number(part), 0);

/** Whether an address needs bracketing to go in a url — that is, whether it is IPv6. */
const isIpv6 = (address: string): boolean => address.includes(':');

/**
 * Addresses another device could reach this machine at, for a server bound on every interface.
 *
 * IPv4 before IPv6, sorted within each family. That ordering means nothing beyond being the same
 * every start: nothing `networkInterfaces()` reports says which address another device can actually
 * reach, and the private ranges do not separate a home LAN from a container bridge — Docker's
 * default one is 172.17.0.0/16.
 *
 * Two things read this. The startup banner turns it into urls, and the self-signed certificate
 * turns it into subject alternative names — which is the whole reason it is a list of addresses
 * rather than of urls. A certificate that does not name the address a phone typed is a certificate
 * that phone rejects before showing anyone anything.
 */
export function listenAddresses(interfaces: InterfaceTable = networkInterfaces()): string[] {
  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;

      if (entry.family === 'IPv4' || entry.family === 4) {
        ipv4.add(entry.address);
        continue;
      }
      if (entry.family !== 'IPv6' && entry.family !== 6) continue;

      // A link-local IPv6 address needs a client-local interface zone to be usable. The server's
      // zone name cannot be put in a URL and handed to another device, so do not advertise it.
      if (/^fe[89ab][0-9a-f]:/i.test(entry.address)) continue;
      ipv6.add(entry.address);
    }
  }

  return [
    ...[...ipv4].sort((a, b) => octetKey(a) - octetKey(b)),
    ...[...ipv6].sort(),
  ];
}

/**
 * Browser-usable urls for one of this server's listeners.
 *
 * Headless and offline machines can have no non-loopback interface at all. Keep the server
 * discoverable on that machine without presenting localhost as if another device could use it.
 */
export function listenUrls(
  scheme: 'http' | 'https',
  port: number,
  addresses: string[] = listenAddresses(),
): string[] {
  const urls = addresses.map((a) => `${scheme}://${isIpv6(a) ? `[${a}]` : a}:${port}`);
  return urls.length > 0 ? urls : [`${scheme}://127.0.0.1:${port}`];
}
