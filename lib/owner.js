// Utilitários para resolução de owner em contexto SaaS

/**
 * Retorna o documento do owner a partir do ownerId.
 * Inclui asaasApiKey, assinafyApiKey, plano, etc.
 */
export async function getOwnerById(db, ownerId) {
  if (!ownerId) throw new Error('ownerId não informado');
  const snap = await db.collection('owners').doc(ownerId).get();
  if (!snap.exists) throw new Error(`Owner não encontrado: ${ownerId}`);
  return { id: snap.id, ...snap.data() };
}

/**
 * Resolve o ownerId a partir de um chargeId ou contractId.
 * Primeiro tenta o campo ownerId do documento. Fallback: owner padrão.
 */
export async function resolveOwnerFromCharge(db, chargeId) {
  const snap = await db.collection('charges').doc(chargeId).get();
  if (!snap.exists) throw new Error('Cobrança não encontrada');
  const ownerId = snap.data().ownerId || await getDefaultOwnerId(db);
  return { charge: snap.data(), chargeDocId: snap.id, ownerId };
}

export async function resolveOwnerFromContract(db, contractId) {
  const snap = await db.collection('contracts').doc(contractId).get();
  if (!snap.exists) throw new Error('Contrato não encontrado');
  const ownerId = snap.data().ownerId || await getDefaultOwnerId(db);
  return { contract: snap.data(), ownerId };
}

/**
 * Fallback para dados antigos sem ownerId: retorna o primeiro owner cadastrado.
 * Remove quando todos os dados estiverem migrados.
 */
let _defaultOwnerId = null;
export async function getDefaultOwnerId(db) {
  if (_defaultOwnerId) return _defaultOwnerId;
  const snap = await db.collection('owners').orderBy('createdAt').limit(1).get();
  if (snap.empty) throw new Error('Nenhum owner cadastrado');
  _defaultOwnerId = snap.docs[0].id;
  return _defaultOwnerId;
}

/**
 * Busca owner pelo email (usado no login do painel admin).
 */
export async function getOwnerByEmail(db, email) {
  const snap = await db.collection('owners')
    .where('email', '==', email).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Lê a config Asaas do owner (com fallback para /config/asaas legado).
 */
export async function getAsaasKey(db, ownerId) {
  try {
    const owner = await getOwnerById(db, ownerId);
    if (owner.asaasApiKey) return owner.asaasApiKey;
  } catch (_) {}
  // fallback legado
  const snap = await db.collection('config').doc('asaas').get();
  return snap.data()?.apiKey;
}

/**
 * Verifica se o plano do owner está ativo.
 * Retorna { active, reason, daysLeft }.
 * Falha de forma aberta (fail-open) para não bloquear usuários legítimos.
 */
export async function checkOwnerPlanActive(db, ownerId) {
  const GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 dias de carência
  try {
    const snap = await db.collection('owners').doc(ownerId).get();
    if (!snap.exists) return { active: false, reason: 'owner_not_found' };
    const d = snap.data();
    const now = Date.now();

    const ms = (ts) => ts?.toMillis?.() ?? (ts?.seconds ? ts.seconds * 1000 : null);

    // Plano pago ativo
    const activeUntil = ms(d.planActiveUntil);
    if (activeUntil && (activeUntil + GRACE_MS) > now && d.status !== 'suspended') {
      return { active: true, reason: 'paid', daysLeft: Math.ceil((activeUntil - now) / 86400000) };
    }

    // Trial ainda válido (aceita trialEndsAt ou trialEnd)
    const trialEnd = ms(d.trialEndsAt) ?? ms(d.trialEnd);
    if (trialEnd && (trialEnd + GRACE_MS) > now) {
      return { active: true, reason: 'trial', daysLeft: Math.ceil((trialEnd - now) / 86400000) };
    }

    if (d.status === 'suspended') return { active: false, reason: 'suspended' };
    if (d.status === 'trial' && !trialEnd) return { active: true, reason: 'trial_no_end' };
    if (trialEnd && trialEnd < now) return { active: false, reason: 'trial_expired' };
    return { active: false, reason: 'plan_expired' };
  } catch (_) {
    return { active: true, reason: 'check_failed' }; // fail-open
  }
}

/**
 * Lê a config Assinafy do owner.
 */
export async function getAssinafyKey(db, ownerId) {
  try {
    const owner = await getOwnerById(db, ownerId);
    if (owner.assinafyApiKey) return owner.assinafyApiKey;
  } catch (_) {}
  // fallback legado
  const snap = await db.collection('config').doc('assinafy').get();
  return snap.data()?.apiKey;
}
