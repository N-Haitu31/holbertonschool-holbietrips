import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };
const bruno = { id: '10000000-0000-4000-8000-000000000002', email: 'bruno.dupont@example.test', full_name: 'Bruno Dupont', role: 'customer' };

const ALICE_BOOKING = '40000000-0000-4000-8000-000000000001';
const BRUNO_BOOKING = '40000000-0000-4000-8000-000000000002';
const UNKNOWN_BOOKING = '40000000-0000-4000-8000-000000000099';

type BookingRow = { id: string; user_id: string; status: string; reference: string };

function fakePool(bookings: BookingRow[], sessionUser = alice) {
  const auditEvents: Array<{ action: string; entity_id: string; metadata: unknown }> = [];

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };

      if (sql.includes('SELECT id,user_id,status,reference FROM bookings')) {
        const row = bookings.find(b => b.id === params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }

      if (sql.includes("UPDATE bookings SET status='cancelled'")) {
        const row = bookings.find(b => b.id === params[0]);
        if (row) row.status = 'cancelled';
        return { rowCount: row ? 1 : 0, rows: row ? [{ id: row.id, reference: row.reference, status: row.status }] : [] };
      }

      if (sql.includes('INSERT INTO audit_events')) {
        auditEvents.push({
          action: params[1] as string,
          entity_id: params[3] as string,
          metadata: JSON.parse(params[4] as string)
        });
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected client query: ${sql}`);
    }),
    release: vi.fn()
  };

  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [sessionUser] };
      throw new Error(`Unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };

  return { pool, client, bookings, auditEvents };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A09 — The Silent Suitcase', () => {
  it('writes an audit event atomically when a cancellation succeeds, without a flag', async () => {
    const fake = fakePool([{ id: ALICE_BOOKING, user_id: alice.id, status: 'pending', reference: 'HT-ALICE-001' }]);
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: `/api/bookings/${ALICE_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice-session' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().booking).toMatchObject({ reference: 'HT-ALICE-001', status: 'cancelled' });
    expect(response.body).not.toContain('FLAG{');

    expect(fake.bookings[0].status).toBe('cancelled');
    expect(fake.auditEvents).toEqual([
      { action: 'booking.cancelled', entity_id: ALICE_BOOKING, metadata: { reference: 'HT-ALICE-001' } }
    ]);
  });

  it('rejects cancelling a booking that does not exist, with an audit event and no mutation', async () => {
    const fake = fakePool([]);
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: `/api/bookings/${UNKNOWN_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice-session' }
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('FLAG{');
    expect(fake.auditEvents).toEqual([
      { action: 'booking.cancel_denied', entity_id: UNKNOWN_BOOKING, metadata: { reason: 'not-found' } }
    ]);
  });

  it('rejects cancelling another traveller\'s booking, with an audit event and no mutation', async () => {
    const fake = fakePool(
      [{ id: BRUNO_BOOKING, user_id: bruno.id, status: 'pending', reference: 'HT-BRUNO-001' }],
      alice
    );
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: `/api/bookings/${BRUNO_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice-session' }
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('FLAG{');
    expect(fake.bookings[0].status).toBe('pending');
    expect(fake.auditEvents).toEqual([
      { action: 'booking.cancel_denied', entity_id: BRUNO_BOOKING, metadata: { reason: 'not-owned' } }
    ]);
  });

  it('rejects cancelling an already-cancelled booking, with an audit event and no mutation', async () => {
    const fake = fakePool([{ id: ALICE_BOOKING, user_id: alice.id, status: 'cancelled', reference: 'HT-ALICE-001' }]);
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: `/api/bookings/${ALICE_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice-session' }
    });

    expect(response.statusCode).toBe(404);
    expect(fake.auditEvents).toEqual([
      { action: 'booking.cancel_denied', entity_id: ALICE_BOOKING, metadata: { reason: 'already-cancelled' } }
    ]);
  });
});