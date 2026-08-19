/**
 * Módulo de segurança compartilhado entre todos os endpoints da API.
 * - Rate limiting via Firestore (persiste entre instâncias serverless)
 * - Sanitização de inputs
 * - Helpers de validação
 */
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ─── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Verifica e incrementa o contador de tentativas por chave (IP, email, etc).
 * Lança erro HTTP 429 se o limite for excedido.
 *
 * @param {string} key     Chave única (ex: "otp:192.168.1.1" ou "otp:user@email.com")
 * @param {object} opts    { maxRequests, windowSeconds }
 */
export async function rateLimit(key, { maxRequests = 10, windowSeconds = 60 } = {}) {
  const db = getFirestore();
  const ref = db.collection('_rateLimits').doc(key.replace(/[^a-zA-Z0-9_@.:+-]/g, '_'));
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  try {
    const snap = await ref.get();
    if (snap.exists) {
      const { count, windowStart } = snap.data();
      if (now - windowStart < windowMs) {
        if (count >= maxRequests) {
          const retryAfter = Math.ceil((windowStart + windowMs - now) / 1000);
          const err = new Error(`Muitas tentativas. Aguarde ${retryAfter}s.`);
          err.status = 429;
          err.retryAfter = retryAfter;
          throw err;
        }
        await ref.update({ count: FieldValue.increment(1) });
      } else {
        // Janela expirada — reinicia
        await ref.set({ count: 1, windowStart: now });
      }
    } else {
      await ref.set({ count: 1, windowStart: now });
    }
  } catch (e) {
    if (e.status === 429) throw e;
    // Falha do Firestore não deve bloquear o fluxo
    console.warn('[rateLimit] erro Firestore:', e.message);
  }
}

/**
 * Reseta o contador de uma chave (uso após autenticação bem-sucedida).
 */
export async function rateLimitReset(key) {
  try {
    const db = getFirestore();
    await db.collection('_rateLimits').doc(key.replace(/[^a-zA-Z0-9_@.:+-]/g, '_')).delete();
  } catch (_) {}
}

// ─── Sanitização ──────────────────────────────────────────────────────────────

/**
 * Remove caracteres de controle e limita tamanho de strings.
 */
export function sanitizeString(val, maxLen = 500) {
  if (typeof val !== 'string') return val;
  return val.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, maxLen).trim();
}

/**
 * Sanitiza recursivamente todas as strings de um objeto.
 */
export function sanitizeBody(obj, maxLen = 500) {
  if (typeof obj === 'string') return sanitizeString(obj, maxLen);
  if (Array.isArray(obj)) return obj.map(v => sanitizeBody(v, maxLen));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[sanitizeString(k, 100)] = sanitizeBody(v, maxLen);
    }
    return out;
  }
  return obj;
}

// ─── Validação ────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email) && email.length <= 254;
}

export function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?[\d\s\-().]{8,20}$/.test(phone);
}

export function requireFields(obj, fields) {
  const missing = fields.filter(f => !obj[f] && obj[f] !== 0);
  if (missing.length) {
    const err = new Error(`Campos obrigatórios ausentes: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

// ─── IP helper ────────────────────────────────────────────────────────────────

export function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ─── CORS & headers de segurança ─────────────────────────────────────────────

export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
