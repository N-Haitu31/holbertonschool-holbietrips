import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };
const BOOKING_ID = '40000000-0000-4000-8000-000000000001';

function fakePool(booking: { status: string; payment_status: string | null }) {
  const state = { ...booking };
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [alice] };
      if (sql.includes('SELECT b.id,b.status')) {
        return { rowCount: 1, rows: [{ id: BOOKING_ID, status: state.status, payment_status: state.payment_status }] };
      }
      if (sql.includes("UPDATE bookings SET status='confirmed'")) {
        state.status = 'confirmed';
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    end: vi.fn(async () => undefined),
    state
  };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A10 — The Emergency Exit Is Open', () => {
  it('rejects confirmation when the readiness check is unavailable, without mutating the booking', async () => {
    const fake = fakePool({ status: 'pending', payment_status: null });
    const app = await buildApp(fake as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: `/api/bookings/${BOOKING_ID}/confirm`,
      headers: { authorization: 'Bearer alice' },
      payload: { simulateCheckFailure: true }
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('FLAG{');
    expect(response.body).not.toContain('Local readiness checker unavailable');
    expect(fake.state.status).toBe('pending');
  });

  it('preserves the normal rejection when payment is missing', async () => {
    const fake = fakePool({ status: 'pending', payment_status: null });
    const app = await buildApp(fake as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: `/api/bookings/${BOOKING_ID}/confirm`,
      headers: { authorization: 'Bearer alice' },
      payload: {}
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('FLAG{');
    expect(fake.state.status).toBe('pending');
  });

  it('confirms a pending booking once payment is approved', async () => {
    const fake = fakePool({ status: 'pending', payment_status: 'approved' });
    const app = await buildApp(fake as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: `/api/bookings/${BOOKING_ID}/confirm`,
      headers: { authorization: 'Bearer alice' },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed' });
    expect(response.body).not.toContain('FLAG{');
    expect(fake.state.status).toBe('confirmed');
  });
});