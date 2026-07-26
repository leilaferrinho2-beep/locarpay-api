/**
 * Middleware de autenticação e verificação de aceite de termos.
 *
 * Uso em qualquer endpoint protegido:
 *   import { requireAuth, requireTerms, withAuth } from './lib/authMiddleware.js'
 *   export default withAuth(handler)           // verifica token + termos
 *   export default withAuth(handler, false)    // verifica só token (rota de aceite)
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth }                       from 'firebase-admin/auth';
import { getFirestore }                  from 'firebase-admin/firestore';
import { createHash }                    from 'crypto';

// Versão corrente dos termos — altere aqui para forçar re-aceite de todos os usuários.
export const CURRENT_TERMS_VERSION = '2025-01';

// ── Firebase Admin (inicializa uma única vez no processo da função) ──────────
function getAdmin() {
  if (getApps().length === 0) {
    // As credenciais vêm de variável de ambiente (Vercel → Settings → Environment Variables)
    // Valor: JSON do service account codificado em base64
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    );
    initializeApp({ credential: cert(serviceAccount) });
  }
  return { auth: getAuth(), db: getFirestore() };
}

// ── Extrai e verifica o Firebase ID Token do header Authorization ────────────
export async function verifyIdToken(req) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw Object.assign(new Error('Token ausente'), { status: 401 });

  const { auth } = getAdmin();
  try {
    return await auth.verifyIdToken(token);
  } catch {
    throw Object.assign(new Error('Token inválido ou expirado'), { status: 401 });
  }
}

// ── Verifica se o usuário aceitou a versão corrente dos termos ───────────────
export async function checkTermsAccepted(uid) {
  const { db } = getAdmin();
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('Usuário não encontrado'), { status: 403 });

  const data = snap.data();
  if (data.acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
    throw Object.assign(
      new Error('Aceite dos termos pendente'),
      { status: 403, code: 'TERMS_PENDING' }
    );
  }
}

// ── Middleware combinado: wraps o handler com autenticação (+ termos opcional) ─
export function withAuth(handler, requireTermsCheck = true) {
  return async (req, res) => {
    // CORS para chamadas do app mobile
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
      const decoded = await verifyIdToken(req);
      req.uid   = decoded.uid;
      req.email = decoded.email;

      if (requireTermsCheck) await checkTermsAccepted(decoded.uid);

      return handler(req, res);
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({
        error: err.message,
        code:  err.code || null
      });
    }
  };
}

// ── Endpoint de aceite: grava o aceite + log de auditoria ───────────────────
export async function recordTermsAcceptance(uid, email, req, termsText) {
  const { db } = getAdmin();
  const now   = new Date();
  const ip    = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket?.remoteAddress
              || 'unknown';
  const ua    = req.headers['user-agent'] || 'unknown';
  const hash  = createHash('sha256').update(termsText).digest('hex');

  // Atualiza documento do usuário
  await db.collection('users').doc(uid).update({
    termsAcceptedAt:      now,
    acceptedTermsVersion: CURRENT_TERMS_VERSION
  });

  // Grava log de auditoria LGPD (imutável — nunca deletar esta coleção)
  await db.collection('termsAuditLog').add({
    uid,
    email,
    termsVersion: CURRENT_TERMS_VERSION,
    ipAddress:    ip,
    userAgent:    ua,
    timestampUtc: now,
    termsHash:    hash,
    platform:     req.headers['x-platform'] || 'unknown'
  });
}
