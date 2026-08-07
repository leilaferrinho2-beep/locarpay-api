// Segurança centralizada: rate limiting, CORS, validação, logs

const ALLOWED_ORIGINS = [
  'https://ilocarpay.com.br',
  'https://www.ilocarpay.com.br',
];

const MAX_ATTEMPTS   = 5;   // tentativas antes de bloquear
const WINDOW_MS      = 15 * 60 * 1000; // janela de 15 minutos
const BLOCK_MS       = 30 * 60 * 1000; // bloqueio de 30 minutos

// ─── CORS ────────────────────────────────────────────────────────────────────

export function setCorsHeaders(req, res, { restrictToSite = false } = {}) {
  const origin = req.headers.origin || '';
  const allowed = restrictToSite
    ? (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0])
    : '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-owner-id');
  res.setHeader('Vary', 'Origin');
}

// ─── IP ──────────────────────────────────────────────────────────────────────

export function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ─── RATE LIMITING (Firestore) ───────────────────────────────────────────────

export async function checkRateLimit(db, ip) {
  const ref  = db.collection('_rate_limits').doc(ip.replace(/[./:]/g, '_'));
  const snap = await ref.get();
  const now  = Date.now();

  if (!snap.exists) return { blocked: false };

  const { attempts, windowStart, blockedUntil } = snap.data();

  // Ainda bloqueado?
  if (blockedUntil && now < blockedUntil) {
    const mins = Math.ceil((blockedUntil - now) / 60000);
    return { blocked: true, message: `Muitas tentativas. Tente novamente em ${mins} min.` };
  }

  // Janela expirou — reseta
  if (now - windowStart > WINDOW_MS) return { blocked: false };

  // Dentro da janela e já bateu o limite
  if (attempts >= MAX_ATTEMPTS) {
    await ref.set({ attempts, windowStart, blockedUntil: now + BLOCK_MS });
    return { blocked: true, message: 'Muitas tentativas. Tente novamente em 30 min.' };
  }

  return { blocked: false };
}

export async function recordFailedAttempt(db, ip) {
  const ref  = db.collection('_rate_limits').doc(ip.replace(/[./:]/g, '_'));
  const snap = await ref.get();
  const now  = Date.now();

  if (!snap.exists || (now - (snap.data().windowStart || 0)) > WINDOW_MS) {
    await ref.set({ attempts: 1, windowStart: now, blockedUntil: null });
  } else {
    const attempts = (snap.data().attempts || 0) + 1;
    const update   = { attempts, windowStart: snap.data().windowStart };
    if (attempts >= MAX_ATTEMPTS) update.blockedUntil = now + BLOCK_MS;
    await ref.set(update);
  }
}

export async function resetRateLimit(db, ip) {
  await db.collection('_rate_limits').doc(ip.replace(/[./:]/g, '_')).delete();
}

// ─── LOGS DE ACESSO ──────────────────────────────────────────────────────────

export async function logAdminAccess(db, { ip, success, detail = '' }) {
  await db.collection('_admin_logs').add({
    ip,
    success,
    detail,
    ts: new Date(),
  });
}

// ─── VALIDAÇÃO DE INPUT ──────────────────────────────────────────────────────

const VALID_STEPS_ADMIN = new Set([
  'list-owners', 'activate-owner', 'suspend-owner', 'delete-owner',
  'setup-asaas', 'create-subscription', 'subscription-status',
  'cancel-subscription', 'request-otp', 'verify-otp', 'delete-tenant',
]);

export function validateAdminInput(body) {
  const { step, ownerId, tenantId } = body || {};
  if (!step || typeof step !== 'string') return 'Campo step obrigatorio';
  if (!VALID_STEPS_ADMIN.has(step)) return `step invalido: ${step}`;
  const ownerRequired = ['activate-owner','suspend-owner','delete-owner',
    'setup-asaas','create-subscription','subscription-status','cancel-subscription'];
  if (ownerRequired.includes(step)) {
    if (!ownerId || typeof ownerId !== 'string' || ownerId.length > 64)
      return 'ownerId invalido';
  }
  if (step === 'delete-tenant') {
    if (!tenantId || typeof tenantId !== 'string' || tenantId.length > 64)
      return 'tenantId invalido';
  }
  return null;
}

export function sanitizeString(s, maxLen = 200) {
  if (typeof s !== 'string') return '';
  return s.replace(/[<>"'`]/g, '').slice(0, maxLen);
}
