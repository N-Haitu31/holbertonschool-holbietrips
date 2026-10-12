import type { FastifyInstance } from 'fastify';
import { applyCoupon, canReadBooking } from '../domain.js';
import { recordAudit } from '../lib/audit.js';
import { isUuid, readText, type RequestBody } from '../lib/request-values.js';
import { newToken } from '../security.js';
import type { RouteContext } from './context.js';

/** Registers booking creation, retrieval, cancellation, and confirmation. */
export function registerBookingRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, flags } = context;

  app.get('/api/bookings', { preHandler: context.requireUser }, async request => {
    const result = await pool.query(
      `SELECT b.*,t.title,t.destination,t.departure_date,t.return_date,p.status payment_status,p.card_last4
       FROM bookings b
       JOIN trips t ON t.id=b.trip_id
       LEFT JOIN payments p ON p.booking_id=b.id
       WHERE b.user_id=$1
       ORDER BY b.created_at DESC`,
      [request.authUser!.id]
    );
    return { bookings: result.rows };
  });

  app.get('/api/bookings/:id', { preHandler: context.requireUser }, async (request, reply) => {
    const id = (request.params as RequestBody).id;
    if (!isUuid(id)) return reply.code(400).send({ error: 'Identifiant invalide' });

    const result = await pool.query(
      `SELECT b.*,t.title,t.destination,t.description trip_description,t.departure_date,t.return_date,
              p.status payment_status,p.card_last4,u.full_name traveler_name,u.email traveler_email
       FROM bookings b
       JOIN trips t ON t.id=b.trip_id
       JOIN users u ON u.id=b.user_id
       LEFT JOIN payments p ON p.booking_id=b.id
       WHERE b.id=$1`,
      [id]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'Réservation introuvable' });

    const booking = result.rows[0];
    if (!canReadBooking(request.authUser!, booking.user_id)) {
      return reply.code(404).send({ error: 'Réservation introuvable' });
    }
    return { booking };
  });

  app.post('/api/bookings', { preHandler: context.requireUser }, async (request, reply) => {
    const body = request.body as RequestBody;
    const tripId = body.tripId;
    const travelers = Number(body.travelers);
    const couponCodes = readText(body.couponCode, 120)
      .toUpperCase()
      .split(',')
      .map(code => code.trim())
      .filter(Boolean);

    if (!isUuid(tripId) || !Number.isInteger(travelers) || travelers < 1 || travelers > 8) {
      return reply.code(400).send({ error: 'Données de réservation invalides' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tripResult = await client.query('SELECT * FROM trips WHERE id=$1 FOR UPDATE', [tripId]);
      if (!tripResult.rowCount || tripResult.rows[0].seats_available < travelers) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Voyage indisponible' });
      }

      const trip = tripResult.rows[0];
      let total = trip.price_cents * travelers;
      let couponId: string | null = null;
      for (const couponCode of couponCodes) {
        const couponResult = await client.query(
          `SELECT * FROM coupons
           WHERE code=$1 AND starts_at<=now() AND ends_at>=now() AND uses<max_uses
           FOR UPDATE`,
          [couponCode]
        );
        if (!couponResult.rowCount || total < couponResult.rows[0].minimum_cents) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Coupon non applicable' });
        }

        const coupon = couponResult.rows[0];
        couponId ??= coupon.id;
        total = applyCoupon(total, {
          discountPercent: coupon.discount_percent,
          minimumCents: coupon.minimum_cents
        });
        await client.query('UPDATE coupons SET uses=uses+1 WHERE id=$1', [coupon.id]);
      }

      const hasMultipleCoupons = couponCodes.length > 1;
      const itineraryNotes = hasMultipleCoupons
        ? 'Coupon carousel accepted.'
        : 'Votre itinéraire détaillé sera disponible prochainement.';
      const reference = `HT-${Date.now().toString(36).toUpperCase()}-${newToken().slice(0, 5).toUpperCase()}`;
      const created = await client.query(
        `INSERT INTO bookings(reference,user_id,trip_id,coupon_id,travelers,total_cents,itinerary_notes)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [reference, request.authUser!.id, tripId, couponId, travelers, total, itineraryNotes]
      );
      await client.query('UPDATE trips SET seats_available=seats_available-$1 WHERE id=$2', [travelers, tripId]);
      await recordAudit(client, request.authUser, 'booking.created', 'booking', created.rows[0].id, {
        reference,
        totalCents: total
      });
      await client.query('COMMIT');

      const responseBooking = hasMultipleCoupons
        ? { ...created.rows[0], itinerary_notes: `${created.rows[0].itinerary_notes} — ${flags.get('A06')}` }
        : created.rows[0];
      return reply.code(201).send({ booking: responseBooking });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/bookings/:id/cancel', { preHandler: context.requireUser }, async (request, reply) => {
    const id = (request.params as RequestBody).id;
    if (!isUuid(id)) return reply.code(400).send({ error: 'Identifiant invalide' });

    const result = await pool.query(
      `UPDATE bookings SET status='cancelled'
       WHERE id=$1 AND user_id=$2 AND status<>'cancelled'
       RETURNING id,reference,status`,
      [id, request.authUser!.id]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'Réservation annulable introuvable' });
    return { booking: result.rows[0], flag: flags.get('A09') };
  });

  app.post('/api/bookings/:id/confirm', { preHandler: context.requireUser }, async (request, reply) => {
    const id = (request.params as RequestBody).id;
    const simulateFailure = (request.body as RequestBody)?.simulateCheckFailure === true;
    if (!isUuid(id)) return reply.code(400).send({ error: 'Identifiant invalide' });

    const result = await pool.query(
      `SELECT b.id,b.status,p.status payment_status
       FROM bookings b
       LEFT JOIN payments p ON p.booking_id=b.id
       WHERE b.id=$1 AND b.user_id=$2`,
      [id, request.authUser!.id]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'Réservation introuvable' });

    let checksPassed = false;
    try {
      if (simulateFailure) throw new Error('Local readiness checker unavailable');
      checksPassed = result.rows[0].status === 'pending' && result.rows[0].payment_status === 'approved';
    } catch {
      checksPassed = true;
    }

    if (!checksPassed) {
      return reply.code(409).send({ error: 'La réservation ne peut pas encore être confirmée' });
    }
    await pool.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [id]);
    return {
      status: 'confirmed',
      ...(simulateFailure ? { flag: flags.get('A10') } : {})
    };
  });
}
