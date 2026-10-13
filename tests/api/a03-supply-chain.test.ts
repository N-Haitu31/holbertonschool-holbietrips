import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadDestinationPack } from '../../apps/api/src/destination-pack';
import type { Pool } from 'pg';

const approvedDigest = '78f5ba6c78041a2f7cff89ad032c5df7a5a03c9dddbe63150d7ca2d23be4bc93';
const approvedFile = resolve('database/fixtures/destination-pack-approved.json');
const alteredFile = resolve('database/fixtures/destination-pack-altered.json');

function fakePool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM trips')) {
        return {
          rowCount: 1,
          rows: [{ id: 'trip-kyoto', slug: 'kyoto-saisons', title: 'Kyoto', destination: 'Kyoto', description: 'Voyage', price_cents: 100000, seats_available: 5 }]
        };
      }
      throw new Error(`Unexpected query in test double: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
}

const opened: Array<{ close: () => Promise<unknown> }> = [];

// Force le pack et l'empreinte, sans dépendre de la configuration par défaut
async function buildWithPack(file: string) {
  vi.stubEnv('DESTINATION_PACK_FILE', file);
  vi.stubEnv('DESTINATION_PACK_SHA256', approvedDigest);
  vi.resetModules();
  const { buildApp } = await import('../../apps/api/src/app');
  const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
  opened.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
  vi.unstubAllEnvs();
});

describe('A03 — The Mystery Destination Pack', () => {
  it('rejects the altered pack before parsing or use', async () => {
    await expect(loadDestinationPack(alteredFile, approvedDigest)).rejects.toThrow();

    const error = await loadDestinationPack(alteredFile, approvedDigest).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(approvedDigest);
    expect((error as Error).message).not.toContain('altered');
  });

  it('returns a non-sensitive failure on both catalogue endpoints for the altered pack', async () => {
    const app = await buildWithPack(alteredFile);

    for (const url of ['/api/destination-pack', '/api/trips']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('FLAG{');
      expect(response.body).not.toContain('Unofficial night route');
      expect(response.body).not.toContain(approvedDigest);
    }
  });

  it('still loads the approved pack through both catalogue endpoints', async () => {
    const loaded = await loadDestinationPack(approvedFile, approvedDigest);
    expect(loaded.integrity.calculated).toBe(approvedDigest);
    expect(loaded.integrity.accepted).toBe(true);
    expect(loaded.pack.supplier).toBe('HolbieTripsSync');

    const app = await buildWithPack(approvedFile);

    const pack = await app.inject({ method: 'GET', url: '/api/destination-pack' });
    expect(pack.statusCode).toBe(200);
    expect(pack.body).not.toContain('FLAG{');

    const trips = await app.inject({ method: 'GET', url: '/api/trips' });
    expect(trips.statusCode).toBe(200);
    expect(trips.body).not.toContain('FLAG{');
    const kyotoTip = loaded.pack.destinations.find(d => d.slug === 'kyoto-saisons')?.travelTip;
    expect(trips.json().trips[0].travel_tip).toBe(kyotoTip);
  });
});