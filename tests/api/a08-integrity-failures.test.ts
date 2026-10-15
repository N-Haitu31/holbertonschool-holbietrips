import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { paymentSignature } from '../../apps/api/src/security';

const PAYMENT_KEY = 'local-demo-payment-signing-key-not-a-real-secret';
const bookingId = '40000000-0000-4000-8000-000000000002';
const amountCents = 129900;

function signedFields(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    bookingId,
    amountCents,
    status: 'approved',
    providerReference: 'FAKE-REF-001',
    cardLast4: '4242',
    ...overrides
  };
}

function fakePool(initialStatus: 'pending' | 'confirmed' = 'pending') {
  const booking = { id: bookingId, total_cents: amountCents, status: initialStatus };
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id FROM bookings')) {
        const [queriedId, queriedAmount] = params;
        const match = queriedId === booking.id
          && queriedAmount === booking.total_cents
          && booking.status === 'pending';
        return { rowCount: match ? 1 : 0, rows: match ? [{ id: booking.id }] : [] };
      }
      if (sql.includes('INSERT INTO payments')) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE bookings SET status')) {
        booking.status = 'confirmed';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected client query: ${sql}`);
    }),
    release: vi.fn()
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };
  return { pool, client, booking };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A08 — Payment Postcard Pretender', () => {
  it('accepts a correctly signed callback and confirms the booking', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const fields = signedFields();
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback',
      payload: { ...fields, signature: paymentSignature(fields, PAYMENT_KEY) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed' });
    expect(response.body).not.toContain('FLAG{');
    expect(fake.booking.status).toBe('confirmed');
  });

  it('rejects an unsigned callback', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback',
      payload: signedFields()
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('FLAG{');
    expect(fake.booking.status).toBe('pending');
  });

  it('rejects a callback with an altered field after signing', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const fields = signedFields();
    const signature = paymentSignature(fields, PAYMENT_KEY);
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback',
      payload: { ...fields, amountCents: fields.amountCents - 1, signature }
    });

    expect(response.statusCode).toBe(401);
    expect(fake.booking.status).toBe('pending');
  });

  it('rejects a validly signed callback for a booking that does not match', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const fields = signedFields({ amountCents: 1 });
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback',
      payload: { ...fields, signature: paymentSignature(fields, PAYMENT_KEY) }
    });

    expect(response.statusCode).toBe(404);
    expect(fake.booking.status).toBe('pending');
  });

  it('rejects a replayed confirmation on an already confirmed booking', async () => {
    const fake = fakePool('confirmed');
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const fields = signedFields();
    const response = await app.inject({
      method: 'POST', url: '/api/payments/callback',
      payload: { ...fields, signature: paymentSignature(fields, PAYMENT_KEY) }
    });

    expect(response.statusCode).toBe(404);
    expect(fake.booking.status).toBe('confirmed');
  });
});