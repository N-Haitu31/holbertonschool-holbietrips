import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

// Jeu de voyages fictifs : un publié, un non publié (simule le seed)
const trips = [
  {
    id: 'kyoto', slug: 'kyoto-saisons', title: 'Kyoto au rythme des saisons', destination: 'Kyoto, Japon',
    description: 'Temples et jardins', departure_date: '2027-10-03', return_date: '2027-10-12',
    price_cents: 219900, seats_available: 9, image_key: 'kyoto', is_published: true
  },
  {
    id: 'hidden', slug: 'archive-search-party', title: 'Dossier interne', destination: 'Archive',
    description: 'Voyage interne réservé aux essais', departure_date: '2027-01-01', return_date: '2027-01-02',
    price_cents: 0, seats_available: 0, image_key: 'archive', is_published: false
  }
];

// Simule WHERE is_published=true AND (title ILIKE $1 OR destination ILIKE $1 OR description ILIKE $1)
function searchPublished(pattern: string | undefined) {
  if (!pattern) return trips.filter(trip => trip.is_published);
  const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
  return trips.filter(trip =>
    trip.is_published &&
    (trip.title.toLowerCase().includes(needle) ||
      trip.destination.toLowerCase().includes(needle) ||
      trip.description.toLowerCase().includes(needle))
  );
}

function fakePool() {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM trips')) {
        const rows = searchPublished(params[0] as string | undefined);
        return { rowCount: rows.length, rows };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A05 — Search Party Crasher', () => {
  it('rejects the crafted search: the payload is bound as data, not SQL, and the hidden trip stays hidden', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    opened.push(app);

    const payload = "%' OR 1=1) -- ";
    const response = await app.inject({ method: 'GET', url: `/api/trips?q=${encodeURIComponent(payload)}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('FLAG{');
    expect(response.body).not.toContain('archive-search-party');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('OR 1=1');
    expect(sql).not.toContain('--');
    expect(params[0]).toBe(`%${payload.trim()}%`);
  });

  it('preserves an ordinary destination search', async () => {
    const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    opened.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/trips?q=Kyoto' });

    expect(response.statusCode).toBe(200);
    expect(response.json().trips[0].title).toContain('Kyoto');
    expect(response.body).not.toContain('archive-search-party');
  });
});