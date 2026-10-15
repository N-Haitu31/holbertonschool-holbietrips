import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../lib/audit.js';
import { readEmail, readText, type RequestBody } from '../lib/request-values.js';
import { internalJson, newToken, tokenDigest } from '../security.js';
import type { AuthUser } from '../types.js';
import type { RouteContext } from './context.js';

/** Registers account creation, sessions, and the local password-reset flow. */
export function registerAuthRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, settings } = context;

  app.post('/api/auth/register', async (request, reply) => {
    const body = request.body as RequestBody;
    const userEmail = readEmail(body.email);
    const fullName = readText(body.fullName, 120);
    const password = readText(body.password, 200);

    if (!userEmail.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/) || fullName.length < 2 || password.length < 12) {
      return reply.code(400).send({ error: 'Nom, e-mail valide et mot de passe de 12 caractères requis' });
    }

    try {
      const result = await pool.query(
        `INSERT INTO users(email,password_hash,full_name,role)
         VALUES($1,crypt($2,gen_salt('bf',10)),$3,'customer')
         RETURNING id,email,full_name,role`,
        [userEmail, password, fullName]
      );
      const account = result.rows[0];
      const user = {
        id: account.id,
        email: account.email,
        fullName: account.full_name,
        role: account.role
      } as AuthUser;
      await recordAudit(pool, user, 'auth.register', 'user', user.id);
      return reply.code(201).send({ user });
    } catch (error: unknown) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'Ce compte existe déjà' });
      }
      throw error;
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as RequestBody;
    const result = await pool.query(
      `SELECT id,email,full_name,role
       FROM users
       WHERE email=$1 AND password_hash=crypt($2,password_hash)`,
      [readEmail(body.email), readText(body.password, 200)]
    );
    if (!result.rowCount) return reply.code(401).send({ error: 'Identifiants invalides' });

    const account = result.rows[0];
    const token = newToken();
    await pool.query(
      `INSERT INTO sessions(token_hash,user_id,expires_at)
       VALUES($1,$2,now()+($3 || ' hours')::interval)`,
      [tokenDigest(token), account.id, settings.sessionHours]
    );
    const user = {
      id: account.id,
      email: account.email,
      fullName: account.full_name,
      role: account.role
    } as AuthUser;
    await recordAudit(pool, user, 'auth.login', 'user', user.id);
    return { token, user };
  });

  app.post('/api/auth/logout', { preHandler: context.requireUser }, async request => {
    const token = request.headers.authorization!.slice(7);
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenDigest(token)]);
    await recordAudit(pool, request.authUser, 'auth.logout', 'user', request.authUser!.id);
    return { ok: true };
  });

  app.post('/api/auth/password-reset/request', async request => {
    const body = request.body as RequestBody;
    const result = await pool.query('SELECT id,email FROM users WHERE email=$1', [readEmail(body.email)]);
    if (result.rowCount) {
      const account = result.rows[0];
      const resetToken = newToken();
      await pool.query(
        `INSERT INTO password_reset_tokens(token_hash,user_id,expires_at)
         VALUES($1,$2,now()+interval '15 minutes')
         ON CONFLICT(token_hash) DO UPDATE
         SET user_id=excluded.user_id,expires_at=excluded.expires_at,used_at=NULL`,
        [tokenDigest(resetToken), account.id]
      );
      await internalJson(`${settings.mailUrl}/messages`, settings.mailUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: account.email, template: 'password-reset', resetToken })
      });
      await recordAudit(pool, null, 'auth.password_reset_requested', 'user', account.id);
    }
    return { message: 'Si le compte existe, un message a été créé.' };
  });

  app.post('/api/auth/password-reset/confirm', async (request, reply) => {
    const body = request.body as RequestBody;
    const token = readText(body.token, 200);
    const password = readText(body.password, 200);
    if (password.length < 12) {
      return reply.code(400).send({ error: '12 caractères minimum' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT user_id FROM password_reset_tokens
         WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL
         FOR UPDATE`,
        [tokenDigest(token)]
      );
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'Jeton invalide ou expiré' });
      }

      const userId = result.rows[0].user_id;
      await client.query(
        `UPDATE users SET password_hash=crypt($1,gen_salt('bf',10)) WHERE id=$2`,
        [password, userId]
      );
      await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1', [tokenDigest(token)]);
      await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      await recordAudit(client, null, 'auth.password_reset_completed', 'user', userId);
      await client.query('COMMIT');
      return { ok: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}