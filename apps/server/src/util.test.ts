import { describe, expect, it } from 'vitest';
import { clientAddress, hashPassword, random, verifyPassword } from './util';

describe('clientAddress', () => {
  const proxy = '172.18.0.1';
  it('uses the socket address when no proxy is trusted', () => {
    expect(clientAddress('203.0.113.9', '1.2.3.4', 0)).toBe('203.0.113.9');
  });
  it('reads one hop back for a single reverse proxy', () => {
    expect(clientAddress(proxy, '203.0.113.9', 1)).toBe('203.0.113.9');
  });
  it('reads two hops back for a CDN in front of a local proxy', () => {
    expect(clientAddress(proxy, '203.0.113.9, 104.21.0.5', 2)).toBe('203.0.113.9');
    // With too few hops configured, every player looks like the CDN.
    expect(clientAddress(proxy, '203.0.113.9, 104.21.0.5', 1)).toBe('104.21.0.5');
  });
  it('ignores addresses a client prepends to the header', () => {
    expect(clientAddress(proxy, '6.6.6.6, 203.0.113.9', 1)).toBe('203.0.113.9');
  });
  it('falls back to the socket address when the header is missing', () => {
    expect(clientAddress('192.168.1.20', undefined, 1)).toBe('192.168.1.20');
    expect(clientAddress('192.168.1.20', '', 2)).toBe('192.168.1.20');
  });
});

describe('password hashing', () => {
  it('verifies the right password and only the right password', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('correct horsf', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });
  it('salts every hash and rejects anything that is not one of its own', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$30$8$1$c2FsdA$aGFzaA')).toBe(false);
  });
});

describe('random', () => {
  it('gives fractions in [0, 1) that turn into fair dice', () => {
    const faces = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) {
      const n = random();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
      faces[Math.floor(n * 6)] += 1;
    }
    for (const count of faces) expect(count).toBeGreaterThan(800);
  });
});
