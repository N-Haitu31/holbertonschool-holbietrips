import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { protectPassport, revealPassport } from '../../apps/api/src/security';

const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const demoPassport = 'FR-DEMO-BRUNO-8742';

const bruno = {
  id: '10000000-0000-4000-8000-000000000002',
  email: 'bruno.dupont@example.test',
  full_name: 'Bruno Dupont',
  role: 'customer'
};

// Modifie un seul bit d'une valeur base64 pour simuler une altération
function tamper(valueBase64: string) {
  const bytes = Buffer.from(valueBase64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

// Double de pool qui mémorise la ligne écrite par PUT et la renvoie à GET
function fakePool() {
  const stored: { row?: Record<string, unknown> } = {};
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.toLowerCase();
      if (text.includes('from sessions')) return { rowCount: 1, rows: [bruno] };
      if (text.includes('insert into traveler_profiles')) {
        stored.row = {
          phone: params[1],
          birth_date: params[2],
          nationality: params[3],
          passport_ciphertext: params[4],
          passport_iv: params[5],
          passport_tag: params[6]
        };
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('from traveler_profiles')) {
        return { rowCount: stored.row ? 1 : 0, rows: stored.row ? [stored.row] : [] };
      }
      if (text.includes('audit')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query in test double: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
  return { pool, stored };
}

const opened: Array<{ close: () => Promise<unknown> }> = [];

// Force le mode et la clé, sans dépendre de la configuration par défaut
async function buildWithProtection(mode: string) {
  vi.stubEnv('PASSPORT_PROTECTION_MODE', mode);
  vi.stubEnv('APP_ENCRYPTION_KEY', key);
  vi.resetModules();
  const { buildApp } = await import('../../apps/api/src/app');
  const { pool, stored } = fakePool();
  const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
  opened.push(app);
  return { app, stored };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
  vi.unstubAllEnvs();
});

describe('A04 — Passport Panic', () => {
  it('refuses the legacy base64 mode for new writes', () => {
    expect(() => protectPassport(demoPassport, key, 'legacy-base64')).toThrow();
  });

  it('stores the passport with authenticated encryption', () => {
    const protectedValue = protectPassport(demoPassport, key, 'aes-256-gcm');

    expect(protectedValue.iv).not.toBe('legacy-base64');
    expect(protectedValue.tag).toBeTruthy();
    expect(protectedValue.ciphertext).not.toContain(demoPassport);
    expect(Buffer.from(protectedValue.ciphertext, 'base64').toString('utf8')).not.toBe(demoPassport);
    expect(revealPassport(protectedValue.ciphertext, protectedValue.iv, protectedValue.tag, key)).toBe(demoPassport);
  });

  it('rejects a tampered ciphertext, a tampered tag and a wrong key', () => {
    const { ciphertext, iv, tag } = protectPassport(demoPassport, key, 'aes-256-gcm');
    const otherKey = 'f'.repeat(64);

    expect(() => revealPassport(tamper(ciphertext), iv, tag, key)).toThrow();
    expect(() => revealPassport(ciphertext, iv, tamper(tag), key)).toThrow();
    expect(() => revealPassport(ciphertext, iv, tag, otherKey)).toThrow();
  });

  it('refuses to reveal a record that still carries the legacy marker', () => {
    const legacyCiphertext = Buffer.from(demoPassport, 'utf8').toString('base64');
    expect(() => revealPassport(legacyCiphertext, 'legacy-base64', null, key)).toThrow();
  });

  it('no longer exposes the local claim endpoint', async () => {
    const { app } = await buildWithProtection('aes-256-gcm');

    const response = await app.inject({
      method: 'POST',
      url: '/api/challenges/a04/claim',
      headers: { authorization: 'Bearer bruno-session' },
      payload: { passportNumber: demoPassport }
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('FLAG{');
  });

  it('lets the owner save and read the passport through the profile routes', async () => {
    const { app, stored } = await buildWithProtection('aes-256-gcm');
    const headers = { authorization: 'Bearer bruno-session' };

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/me',
      headers,
      payload: { phone: '+33 6 00 00 00 02', birthDate: '1987-09-23', nationality: 'Française', passportNumber: demoPassport }
    });
    expect(saved.statusCode).toBe(200);

    // Ce que la base contient réellement : illisible sans la clé
    expect(stored.row?.passport_iv).not.toBe('legacy-base64');
    expect(stored.row?.passport_tag).toBeTruthy();
    expect(String(stored.row?.passport_ciphertext)).not.toContain(demoPassport);

    const read = await app.inject({ method: 'GET', url: '/api/me', headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().profile.passportNumber).toBe(demoPassport);
  });
});