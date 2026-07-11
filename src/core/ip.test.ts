import { describe, expect, it } from 'vitest';
import { addressInPrefix, compareIp, normalizePrefix, parseIp, parsePrefix, prefixesOverlap } from './ip';

describe('IP primitives', () => {
  it.each([
    ['192.0.2.129/24', '192.0.2.0/24'],
    ['2001:0db8:0000:0000::1/48', '2001:db8::/48'],
    ['::ffff:192.0.2.1/128', '::ffff:c000:201/128'],
    ['0.0.0.0/0', '0.0.0.0/0'],
    ['::/0', '::/0'],
  ])('normalizes %s', (input, expected) => expect(normalizePrefix(input)).toBe(expected));

  it('performs family-safe prefix membership and overlap', () => {
    expect(addressInPrefix('203.0.113.53', '203.0.113.0/24')).toBe(true);
    expect(addressInPrefix('203.0.114.1', '203.0.113.0/24')).toBe(false);
    expect(addressInPrefix('2001:db8::53', '2001:db8::/48')).toBe(true);
    expect(addressInPrefix('203.0.113.53', '2001:db8::/48')).toBe(false);
    expect(prefixesOverlap('10.0.0.0/8', '10.20.0.0/16')).toBe(true);
    expect(prefixesOverlap('10.0.0.0/8', '11.0.0.0/8')).toBe(false);
  });

  it('parses and orders IPv4 and IPv6 deterministically', () => {
    expect(parseIp('2001:db8::1').canonical).toBe('2001:db8::1');
    expect(parsePrefix('192.0.2.4/31').prefixLength).toBe(31);
    expect(compareIp('192.0.2.1', '192.0.2.2')).toBeLessThan(0);
    expect(compareIp('255.255.255.255', '::1')).toBeLessThan(0);
  });

  it.each(['300.1.1.1', '192.0.2', '2001:::1', '2001:db8::/129', '10.0.0.1/33'])('rejects malformed input %s', (input) => {
    expect(() => input.includes('/') ? parsePrefix(input) : parseIp(input)).toThrow();
  });
});
