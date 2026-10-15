import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { legacyResetToken, newToken, tokenDigest } from '../../apps/api/src/security';

const bruno = { id: '10000000-0000-4000-8000-000000000002', email: 'bruno.dupont@example.test' };

function fakePool() {
  const resetTokens = new Map<string, { user_id: string; expires_at: Date; used_at: Date | null }>();
  const sessions = new Set<string>([bruno.id]); // simule une session active avant le reset

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT user_id FROM password_reset_tokens')) {
        const entry = resetTokens.get(params[0] as string);
        const valid = entry && entry.expires_at > new Date() && entry.used_at === null;
        return { rowCount: valid ? 1 : 0, rows: valid ? [{ user_id: entry!.user_id }] : [] };
      }
      if (sql.includes('UPDATE users SET password_hash')) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE password_reset_tokens SET used_at=now()')) {
        const entry = resetTokens.get(params[0] as string);
        if (entry) entry.used_at = new Date();
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('DELETE FROM sessions')) {
        sessions.delete(params[0] as string);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected client query: ${sql}`);
    }),
    release: vi.fn()
  };

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id,email FROM users WHERE email=$1')) {
        return params[0] === bruno.email ? { rowCount: 1, rows: [bruno] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO password_reset_tokens')) {
        resetTokens.set(params[0] as string, {
          user_id: params[1] as string,
          expires_at: new Date(Date.now() + 15 * 60 * 1000),
          used_at: null
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };

  return { pool, client, resetTokens, sessions };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
  vi.restoreAllMocks();
});

describe('A07 — Reset Route Roulette', () => {
  it('characterizes the flaw: a reset token is predictable from the e-mail address', () => {
    const first = legacyResetToken('bruno.dupont@example.test');
    const second = legacyResetToken('bruno.dupont@example.test');
    expect(first).toBe(second);
    expect(Buffer.from(first, 'base64url').toString('utf8')).toBe('bruno.dupont@example.test');
  });

  it('documents the expected positive property of a secure token', () => {
    expect(newToken()).not.toBe(newToken());
  });

  it('rejects a predicted legacy-style token at confirmation', async () => {
    const fake = fakePool();
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    await app.inject({
      method: 'POST', url: '/api/auth/password-reset/request',
      payload: { email: bruno.email }
    });

    const predicted = legacyResetToken(bruno.email);
    const response = await app.inject({
      method: 'POST', url: '/api/auth/password-reset/confirm',
      payload: { token: predicted, password: 'TentativeAttaquant1' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('FLAG{');
    expect(fake.sessions.has(bruno.id)).toBe(true); // aucune session révoquée
  });

  it('completes a legitimate reset end to end and revokes existing sessions', async () => {
    const fake = fakePool();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    await app.inject({
      method: 'POST', url: '/api/auth/password-reset/request',
      payload: { email: bruno.email }
    });

    const sentInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const { resetToken } = JSON.parse(sentInit.body as string);
    expect(resetToken).not.toBe(legacyResetToken(bruno.email));

    const response = await app.inject({
      method: 'POST', url: '/api/auth/password-reset/confirm',
      payload: { token: resetToken, password: 'NouveauMotDePasse123' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.body).not.toContain('FLAG{');
    expect(fake.sessions.has(bruno.id)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const token = 'expired-token';
    fake.resetTokens.set(tokenDigest(token), {
      user_id: bruno.id,
      expires_at: new Date(Date.now() - 1000),
      used_at: null
    });

    const response = await app.inject({
      method: 'POST', url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'NouveauMotDePasse123' }
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an already-used token', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const token = 'already-used-token';
    fake.resetTokens.set(tokenDigest(token), {
      user_id: bruno.id,
      expires_at: new Date(Date.now() + 60_000),
      used_at: new Date()
    });

    const response = await app.inject({
      method: 'POST', url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'NouveauMotDePasse123' }
    });

    expect(response.statusCode).toBe(400);
  });
});