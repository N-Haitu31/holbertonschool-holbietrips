import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const customer = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice.martin@example.test',
  full_name: 'Alice Martin',
  role: 'customer'
};

const support = {
  id: '10000000-0000-4000-8000-000000000003',
  email: 'support@holbietrips.test',
  full_name: 'HolbieTrips Support',
  role: 'support'
};

function fakePool(account: typeof customer | typeof support = customer) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [account] };
      if (sql.includes('FROM trips')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query in test double: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A02 — The Debug Desk Left Open', () => {
  it('denies a customer the support diagnostics desk even when diagnostics are enabled by mistake', async () => {
    const app = await buildApp(fakePool(customer) as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: true });
    opened.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/support/diagnostics',
      headers: { authorization: 'Bearer customer-session' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('FLAG{');
    expect(response.body).not.toContain('fake-payment');
    expect(response.body).not.toContain('Debug Desk');
  });

  it('preserves the intended support journey while the desk is enabled', async () => {
    const app = await buildApp(fakePool(support) as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: true });
    opened.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/support/diagnostics',
      headers: { authorization: 'Bearer support-session' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().intendedAudience).toBe('support');
  });

  it('keeps the public trip catalogue available when diagnostics are disabled', async () => {
    const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    opened.push(app);

    const diagnostics = await app.inject({ method: 'GET', url: '/api/support/diagnostics' });
    const catalogue = await app.inject({ method: 'GET', url: '/api/trips' });

    expect(diagnostics.statusCode).toBe(404);
    expect(diagnostics.headers['x-holbietrips-debug-desk']).toBeUndefined();
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.json()).toEqual({ trips: [] });
  });
});