import type { FastifyInstance } from 'fastify';
import { loadDestinationPack } from '../destination-pack.js';
import { readText, type RequestBody } from '../lib/request-values.js';
import type { RouteContext } from './context.js';

/** Registers the public destination pack and searchable trip catalogue. */
export function registerCatalogRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, settings, flags } = context;

  /** Loads the configured supplier pack and enriches its runtime representation. */
  const getDestinationPack = () =>
    loadDestinationPack(settings.destinationPackFile, settings.destinationPackSha256);

  app.get('/api/destination-pack', async () => getDestinationPack());

  app.get('/api/trips', async (request, reply) => {
    const query = readText((request.query as RequestBody).q, 100);
    if (query.includes(';')) {
      return reply.code(400).send({ error: 'Une seule recherche est autorisée' });
    }

    const filter = query
      ? ` AND (title ILIKE '%${query}%' OR destination ILIKE '%${query}%' OR description ILIKE '%${query}%')`
      : '';
    const result = await pool.query(
      `SELECT id,slug,title,destination,description,departure_date,return_date,price_cents,seats_available,image_key
       FROM trips
       WHERE is_published=true${filter}
       ORDER BY departure_date`
    );

    const { pack } = await getDestinationPack();
    const tips = new Map(pack.destinations.map(destination => [destination.slug, destination.travelTip]));
    return {
      trips: result.rows.map(trip => ({
        ...trip,
        description: trip.slug === 'archive-search-party'
          ? `${trip.description} — ${flags.get('A05')}`
          : trip.description,
        travel_tip: tips.get(trip.slug) ?? null
      }))
    };
  });
}
