import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

/** Produces the compatibility token used by the seeded local reset workflow. */
export const legacyResetToken = (email: string) => Buffer.from(email.toLowerCase(), 'utf8').toString('base64url');

/** Encrypts a sensitive string with AES-256-GCM and a fresh nonce. */
export function encryptSensitive(value: string, keyHex: string) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY doit contenir 32 octets hexadécimaux');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Authenticates and decrypts an AES-256-GCM payload. */
export function decryptSensitive(ciphertext: string, iv: string, tag: string, keyHex: string) {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Applies the configured protection mode to a traveller document value. */
export function protectPassport(value: string, keyHex: string, mode: string) {
  if (mode !== 'aes-256-gcm') throw new Error('Mode de protection du passeport non pris en charge');
  return encryptSensitive(value, keyHex);
}

export function revealPassport(ciphertext: string, iv: string | null, tag: string | null, keyHex: string) {
  if (!iv || !tag) throw new Error('Protection du passeport invalide');
  return decryptSensitive(ciphertext, iv, tag, keyHex);
}


export const paymentSignature = (payload: object, key: string) =>
  createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');

/** Compares a payment signature without data-dependent timing differences. */
export function validSignature(payload: object, signature: string, key: string) {
  const expected = Buffer.from(paymentSignature(payload, key), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Restricts service-to-service HTTP calls to one explicitly configured origin. */
export async function internalJson(url: string, allowedBase: string, init?: RequestInit) {
  const target = new URL(url);
  const allowed = new URL(allowedBase);
  if (target.protocol !== 'http:' || target.hostname !== allowed.hostname || target.port !== allowed.port) {
    throw new Error('Destination réseau refusée');
  }
  const response = await fetch(target, { ...init, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Service interne indisponible (${response.status})`);
  return response.json();
}
