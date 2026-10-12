import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const ALICE_BOOKING = '40000000-0000-4000-8000-000000000001';
const BRUNO_BOOKING = '40000000-0000-4000-8000-000000000002';

const alice = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice.martin@example.test',
  full_name: 'Alice Martin',
  role: 'customer'
};

const support = {
  id: '10000000-0000-4000-8000-000000000003',
  email: 'support@holbietrips.test',
  full_name: 'Support HolbieTrips',
  role: 'support'
};

const bookings = new Map([
  [ALICE_BOOKING, { id: ALICE_BOOKING, user_id: alice.id, reference: 'HT-ALICE-001', itinerary_notes: 'Transfert vers l’hôtel inclus.' }],
  [BRUNO_BOOKING, { id: BRUNO_BOOKING, user_id: '10000000-0000-4000-8000-000000000002', reference: 'HT-BRUNO-001', itinerary_notes: 'Cabine 12, pont Panorama.' }]
]);

function fakePool(sessionUser = alice) {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [sessionUser] };
      if (sql.includes('FROM bookings b') && sql.includes('WHERE b.id=$1')) {
        const booking = bookings.get(String(params[0]));
        return { rowCount: booking ? 1 : 0, rows: booking ? [booking] : [] };
      }
      throw new Error(`Requête inattendue dans le double de test: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function open(sessionUser = alice) {
  const app = await buildApp(fakePool(sessionUser) as unknown as Pool, { serveFrontend: false });
  opened.push(app);
  return app;
}

describe('A01 — Boarding Pass Mix-Up', () => {
  it('rejette l’accès d’Alice à la réservation de Bruno sans divulguer le flag', async () => {
    const app = await open();
    const response = await app.inject({ method: 'GET', url: `/api/bookings/${BRUNO_BOOKING}`, headers: { authorization: 'Bearer alice-session' } });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('FLAG{');
    expect(response.body).not.toContain('HT-BRUNO-001');
    expect(response.body).not.toContain('Cabine 12');
  });

  it('préserve le parcours positif : Alice peut lire sa propre réservation', async () => {
    const app = await open();
    const response = await app.inject({ method: 'GET', url: `/api/bookings/${ALICE_BOOKING}`, headers: { authorization: 'Bearer alice-session' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.reference).toBe('HT-ALICE-001');
    expect(response.body).not.toContain('FLAG{');
  });

  it('préserve l’accès du support : il peut lire une réservation à partir de son identifiant', async () => {
    const app = await open(support);
    const response = await app.inject({ method: 'GET', url: `/api/bookings/${BRUNO_BOOKING}`, headers: { authorization: 'Bearer support-session' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.reference).toBe('HT-BRUNO-001');
    expect(response.body).not.toContain('FLAG{');
  });
});