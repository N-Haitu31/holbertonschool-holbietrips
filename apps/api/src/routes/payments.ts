import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../lib/audit.js';
import { isUuid, readText, type RequestBody } from '../lib/request-values.js';
import { internalJson, validSignature } from '../security.js';
import type { RouteContext } from './context.js';

type PaymentResponse = {
  bookingId: string;
  amountCents: number;
  status: string;
  providerReference: string;
  cardLast4: string;
  signature?: string;
};

/** Registers the checkout flow and the internal payment notification endpoint. */
export function registerPaymentRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, settings } = context;

  app.post('/api/bookings/:id/pay', { preHandler: context.requireUser }, async (request, reply) => {
    const id = (request.params as RequestBody).id;
    const cardNumber = readText((request.body as RequestBody).cardNumber, 30).replace(/\D/g, '');
    if (!isUuid(id) || !/^\d{16}$/.test(cardNumber)) {
      return reply.code(400).send({ error: 'Données de paiement invalides' });
    }

    const bookingResult = await pool.query(
      `SELECT id,reference,total_cents
       FROM bookings
       WHERE id=$1 AND user_id=$2 AND status='pending'`,
      [id, request.authUser!.id]
    );
    if (!bookingResult.rowCount) {
      return reply.code(404).send({ error: 'Réservation payable introuvable' });
    }

    const booking = bookingResult.rows[0];
    let payment: PaymentResponse;
    try {
      payment = await internalJson(`${settings.paymentUrl}/payments`, settings.paymentUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bookingId: booking.id,
          reference: booking.reference,
          amountCents: booking.total_cents,
          cardNumber
        })
      }) as PaymentResponse;
    } catch {
      await recordAudit(pool, request.authUser, 'payment.failed', 'booking', booking.id, {
        reason: 'internal-service-error'
      });
      return reply.code(502).send({ error: 'Paiement indisponible, réservation non confirmée' });
    }

    const signedFields = {
      bookingId: payment.bookingId,
      amountCents: payment.amountCents,
      status: payment.status,
      providerReference: payment.providerReference,
      cardLast4: payment.cardLast4
    };
    const validPayment = validSignature(signedFields, payment.signature ?? '', settings.paymentKey)
      && signedFields.bookingId === booking.id
      && signedFields.amountCents === booking.total_cents
      && signedFields.status === 'approved';
    if (!validPayment) {
      await recordAudit(pool, request.authUser, 'payment.rejected', 'booking', booking.id, {
        reason: 'invalid-confirmation'
      });
      return reply.code(502).send({ error: 'Confirmation de paiement invalide' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO payments(booking_id,provider_reference,amount_cents,card_last4,status)
         VALUES($1,$2,$3,$4,'approved')`,
        [booking.id, signedFields.providerReference, booking.total_cents, signedFields.cardLast4]
      );
      await client.query(
        `UPDATE bookings SET status='confirmed' WHERE id=$1 AND status='pending'`,
        [booking.id]
      );
      await recordAudit(client, request.authUser, 'payment.approved', 'booking', booking.id, {
        providerReference: signedFields.providerReference
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    void internalJson(`${settings.mailUrl}/messages`, settings.mailUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: request.authUser!.email,
        template: 'booking-confirmed',
        reference: booking.reference
      })
    }).catch(() => undefined);
    return { status: 'confirmed', reference: booking.reference };
  });

  app.post('/api/payments/callback', async (request, reply) => {
    const body = request.body as RequestBody;
    const bookingId = body.bookingId;
    const amountCents = Number(body.amountCents);
    const status = readText(body.status, 20);
    const providerReference = readText(body.providerReference, 80);
    const cardLast4 = readText(body.cardLast4, 4);
    const signature = readText(body.signature, 200);

    const validPayload = isUuid(bookingId)
      && Number.isInteger(amountCents)
      && status === 'approved'
      && providerReference.length >= 5
      && /^\d{4}$/.test(cardLast4);
    if (!validPayload) return reply.code(400).send({ error: 'Confirmation invalide' });

    const signedFields = { bookingId, amountCents, status, providerReference, cardLast4 };
    if (!validSignature(signedFields, signature, settings.paymentKey)) {
      await recordAudit(pool, null, 'payment.callback_rejected', 'booking', bookingId, {
        reason: 'invalid-signature'
      });
      return reply.code(401).send({ error: 'Signature de confirmation invalide' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bookingResult = await client.query(
        `SELECT id FROM bookings
         WHERE id=$1 AND total_cents=$2 AND status='pending'
         FOR UPDATE`,
        [bookingId, amountCents]
      );
      if (!bookingResult.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Réservation payable introuvable' });
      }

      await client.query(
        `INSERT INTO payments(booking_id,provider_reference,amount_cents,card_last4,status)
         VALUES($1,$2,$3,$4,'approved')
         ON CONFLICT(booking_id) DO UPDATE
         SET provider_reference=excluded.provider_reference,amount_cents=excluded.amount_cents,
             card_last4=excluded.card_last4,status='approved'`,
        [bookingId, providerReference, amountCents, cardLast4]
      );
      await client.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [bookingId]);
      await recordAudit(client, null, 'payment.callback_approved', 'booking', bookingId, {
        providerReference
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { status: 'confirmed' };
  });
}