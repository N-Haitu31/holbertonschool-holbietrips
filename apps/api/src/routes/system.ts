import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

/** Registers operational endpoints used by Docker and the local support area. */
export function registerSystemRoutes(
  app: FastifyInstance,
  context: RouteContext,
  diagnosticsEnabled: boolean
): void {
  app.get('/api/health', async () => ({ status: 'ok', service: 'holbietrips' }));

  if (!diagnosticsEnabled) return;
  app.get('/api/support/diagnostics', { preHandler: context.requireRole('support') }, async () => ({
    desk: 'HolbieTrips Support Debug Desk',
    status: 'open',
    intendedAudience: 'support',
    runtime: {
      environment: process.env.NODE_ENV ?? 'development',
      node: process.version
    },
    internalServices: {
      api: 'app:8080',
      database: 'db:5432',
      paymentSimulator: 'fake-payment:8081',
      mailSimulator: 'fake-mail:8082'
    },
    operatorNote: 'If a customer can read this, the Debug Desk was left open.',
    flag: context.flags.get('A02')
  }));
}
