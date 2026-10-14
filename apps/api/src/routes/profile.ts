import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../lib/audit.js';
import { readText, type RequestBody } from '../lib/request-values.js';
import { protectPassport, revealPassport } from '../security.js';
import type { RouteContext } from './context.js';

type ProfileRow = {
  phone: string | null;
  birth_date: string | null;
  nationality: string | null;
  passport_ciphertext: string | null;
  passport_iv: string | null;
  passport_tag: string | null;
};

/** Registers the authenticated traveller profile read and update operations. */
export function registerProfileRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, settings } = context;

  app.get('/api/me', { preHandler: context.requireUser }, async request => {
    const result = await pool.query<ProfileRow>(
      `SELECT phone,birth_date,nationality,passport_ciphertext,passport_iv,passport_tag
       FROM traveler_profiles
       WHERE user_id=$1`,
      [request.authUser!.id]
    );
    const profile = result.rows[0];
    return {
      user: request.authUser,
      profile: profile
        ? {
            phone: profile.phone,
            birthDate: profile.birth_date,
            nationality: profile.nationality,
            passportNumber: profile.passport_ciphertext
              ? revealPassport(
                  profile.passport_ciphertext,
                  profile.passport_iv,
                  profile.passport_tag,
                  settings.encryptionKey
                )
              : ''
          }
        : null
    };
  });

  app.put('/api/me', { preHandler: context.requireUser }, async request => {
    const body = request.body as RequestBody;
    const passportNumber = readText(body.passportNumber, 30);
    const protectedPassport = passportNumber
      ? protectPassport(passportNumber, settings.encryptionKey, settings.passportProtectionMode)
      : { ciphertext: null, iv: null, tag: null };

    await pool.query(
      `INSERT INTO traveler_profiles(user_id,phone,birth_date,nationality,passport_ciphertext,passport_iv,passport_tag)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(user_id) DO UPDATE
       SET phone=excluded.phone,birth_date=excluded.birth_date,nationality=excluded.nationality,
           passport_ciphertext=excluded.passport_ciphertext,passport_iv=excluded.passport_iv,
           passport_tag=excluded.passport_tag,updated_at=now()`,
      [
        request.authUser!.id,
        readText(body.phone, 30),
        body.birthDate || null,
        readText(body.nationality, 60),
        protectedPassport.ciphertext,
        protectedPassport.iv,
        protectedPassport.tag
      ]
    );
    await recordAudit(pool, request.authUser, 'profile.updated', 'user', request.authUser!.id, {
      passportChanged: Boolean(passportNumber)
    });
    return { ok: true };
  });
}