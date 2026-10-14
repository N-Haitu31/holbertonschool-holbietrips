import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };

function fakePool() {
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT * FROM trips')) return { rowCount: 1, rows: [{ id: params[0], price_cents: 100000, seats_available: 8 }] };
      if (sql.includes('SELECT * FROM coupons')) return { rowCount: 1, rows: [{ id: 'coupon-1', discount_percent: 10, minimum_cents: 0 }] };
      if (sql.includes('INSERT INTO bookings')) return { rowCount: 1, rows: [{ reference: params[0], total_cents: params[5], itinerary_notes: params[6] }] };
      if (sql.includes('UPDATE coupons') || sql.includes('UPDATE trips') || sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected client query: ${sql}`);
    }),
    release: vi.fn()
  };
  return {
    pool: {
      query: vi.fn(async (sql: string) => sql.includes('FROM sessions') ? { rowCount: 1, rows: [alice] } : Promise.reject(new Error(`Unexpected pool query: ${sql}`))),
      connect: vi.fn(async () => client), end: vi.fn(async () => undefined)
    }, client
  };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A06 — Coupon Carousel', () => {
  it('rejects a stacked coupon payload before opening any database connection', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: '/api/bookings', headers: { authorization: 'Bearer alice' },
      payload: { tripId: '20000000-0000-4000-8000-000000000001', travelers: 1, couponCode: 'BIENVENUE10,BIENVENUE10' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('FLAG{');
    expect(fake.pool.connect).not.toHaveBeenCalled();
    expect(fake.client.query).not.toHaveBeenCalled();
  });

  it('preserves a single valid coupon', async () => {
    const fake = fakePool(); const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false }); opened.push(app);
    const response = await app.inject({ method: 'POST', url: '/api/bookings', headers: { authorization: 'Bearer alice' },
      payload: { tripId: '20000000-0000-4000-8000-000000000001', travelers: 1, couponCode: 'BIENVENUE10' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().booking.total_cents).toBe(90000);
    expect(response.body).not.toContain('FLAG{');
  });
});