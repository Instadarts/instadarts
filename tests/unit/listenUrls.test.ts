import { describe, expect, it } from 'vitest';
import { httpListenUrls } from '../../src/server/listenUrls';

describe('startup listen URLs', () => {
  it('lists non-loopback IPv4 and usable IPv6 addresses without duplicates', () => {
    const interfaces = {
      lo: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true },
      ],
      ethernet: [
        { address: '192.168.1.40', family: 'IPv4', internal: false },
        { address: 'fd00::40', family: 'IPv6', internal: false },
        { address: 'fe80::40', family: 'IPv6', internal: false },
      ],
      duplicate: [
        { address: '192.168.1.40', family: 4, internal: false },
      ],
    };

    expect(httpListenUrls(3000, interfaces)).toEqual([
      'http://192.168.1.40:3000',
      'http://[fd00::40]:3000',
    ]);
  });

  // The same machine should print the same list every start, so the order cannot be the order
  // `networkInterfaces()` happened to report. It says nothing about which address is reachable.
  it('puts IPv4 before IPv6 and sorts within each family', () => {
    const interfaces = {
      wifi: [
        { address: 'fd00::40', family: 'IPv6', internal: false },
        { address: '192.168.1.10', family: 'IPv4', internal: false },
      ],
      docker: [
        { address: '172.17.0.1', family: 'IPv4', internal: false },
      ],
      wired: [
        { address: 'fd00::9', family: 'IPv6', internal: false },
        { address: '192.168.1.9', family: 'IPv4', internal: false },
      ],
    };

    expect(httpListenUrls(3000, interfaces)).toEqual([
      'http://172.17.0.1:3000',
      'http://192.168.1.9:3000',
      'http://192.168.1.10:3000',
      'http://[fd00::40]:3000',
      'http://[fd00::9]:3000',
    ]);
  });

  it('falls back to a numeric loopback address when no network interface is available', () => {
    expect(httpListenUrls(8080, {})).toEqual(['http://127.0.0.1:8080']);
  });
});
