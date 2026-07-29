// POST /api/locarpay-owner
// step:"register"     → { name, email, phone?, cpfCnpj?, companyType?, address?, addressNumber?, province?, postalCode?, plan?, firebaseUid? }
// step:"setup-asaas"  → { ownerId } → (re)cria subconta Asaas para owner existente
// step:"migrate"      → { secret, ownerId } → backfill ownerId em docs legados (requer MIGRATE_SECRET)
// step:"get"          → { ownerId } → retorna dados públicos do owner

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp }       from 'firebase-admin/firestore';

const PLANS = {
  trial: { maxTenants: 3,  maxProperties: 2,  monthlyPrice: 0   },
  basic: { maxTenants: 10, maxProperties: 5,  monthlyPrice: 49  },
  pro:   { maxTenants: 30, maxProperties: 20, monthlyPrice: 99  },
};

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

// Lê a chave master Asaas (da conta principal)
async function getMasterAsaasKey(db) {
  // Tenta primeiro no owner master (transgu-owner-001), fallback para /config/asaas
  try {
    const masterSnap = await db.collection('owners').doc('transgu-owner-001').get();
    if (masterSnap.exists && masterSnap.data().asaasApiKey) return masterSnap.data().asaasApiKey;
  } catch (_) {}
  const configSnap = await db.collection('config').doc('asaas').get();
  return configSnap.data()?.apiKey;
}

// Lê a chave Assinafy compartilhada (centralizada)
async function getSharedAssinafyKey(db) {
  try {
    const masterSnap = await db.collection('owners').doc('transgu-owner-001').get();
    if (masterSnap.exists && masterSnap.data().assinafyApiKey) return masterSnap.data().assinafyApiKey;
  } catch (_) {}
  const configSnap = await db.collection('config').doc('assinafy').get();
  return configSnap.data()?.apiKey;
}

// Cria subconta Asaas Connect
async function createAsaasSubaccount(masterKey, ownerData) {
  const cpfCnpj = (ownerData.cpfCnpj || ownerData.cnpj || '').replace(/\D/g, '');
  const phone   = (ownerData.phone || '').replace(/\D/g, '');

  // companyType: MEI | LIMITED | INDIVIDUAL | ASSOCIATION
  const companyType = ownerData.companyType || (cpfCnpj.length === 14 ? 'LIMITED' : undefined);

  const body = {
    name:          ownerData.name,
    email:         ownerData.email,
    cpfCnpj:       cpfCnpj || undefined,
    companyType:   companyType,
    mobilePhone:   phone || undefined,
    address:       ownerData.address       || undefined,
    addressNumber: ownerData.addressNumber || undefined,
    province:      ownerData.province      || undefined,
    postalCode:    (ownerData.postalCode || '').replace(/\D/g, '') || undefined,
  };

  // Remove campos undefined
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  const r = await fetch('https://api.asaas.com/v3/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': masterKey },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas subaccount: ${r.status} ${JSON.stringify(json)}`);
  return json; // { apiKey, walletId, id, ... }
}

async function handleRegister(db, body) {
  const {
    name, email, phone, cpfCnpj, cnpj, companyType,
    address, addressNumber, province, postalCode,
    plan = 'trial', firebaseUid
  } = body;
  if (!name || !email) throw Object.assign(new Error('name e email são obrigatórios'), { status: 400 });

  const existing = await db.collection('owners').where('email', '==', email).limit(1).get();
  if (!existing.empty) {
    throw Object.assign(new Error('Email já cadastrado'), { status: 409, ownerId: existing.docs[0].id });
  }

  const now = Timestamp.now();
  const trialEndsAt = Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const planConfig = PLANS[plan] || PLANS.trial;

  const docRef = firebaseUid
    ? db.collection('owners').doc(firebaseUid)
    : db.collection('owners').doc();

  // Cria documento básico primeiro
  const ownerData = {
    name,
    email,
    phone:         phone         || '',
    cpfCnpj:       (cpfCnpj || cnpj || '').replace(/\D/g, ''),
    companyType:   companyType   || '',
    address:       address       || '',
    addressNumber: addressNumber || '',
    province:      province      || '',
    postalCode:    (postalCode || '').replace(/\D/g, ''),
    plan,
    status: 'trial',
    maxTenants:    planConfig.maxTenants,
    maxProperties: planConfig.maxProperties,
    monthlyPrice:  planConfig.monthlyPrice,
    asaasApiKey:       '',
    asaasSubaccountId: '',
    assinafyApiKey:    '',
    createdAt:      now,
    trialEndsAt,
    planActiveUntil: trialEndsAt,
  };

  await docRef.set(ownerData);

  // Cria subconta Asaas e copia chave Assinafy
  const updates = {};
  let asaasError = null;

  try {
    const masterKey = await getMasterAsaasKey(db);
    if (masterKey) {
      const subaccount = await createAsaasSubaccount(masterKey, { ...ownerData, email });
      updates.asaasApiKey       = subaccount.apiKey    || '';
      updates.asaasSubaccountId = subaccount.walletId  || subaccount.id || '';
    }
  } catch (e) {
    asaasError = e.message;
    console.warn('Asaas subaccount creation failed:', e.message);
  }

  // Copia chave Assinafy compartilhada
  try {
    const assinafyKey = await getSharedAssinafyKey(db);
    if (assinafyKey) updates.assinafyApiKey = assinafyKey;
  } catch (_) {}

  if (Object.keys(updates).length > 0) {
    await docRef.update(updates);
  }

  return {
    ownerId:    docRef.id,
    trialEndsAt: trialEndsAt.toDate().toISOString(),
    plan,
    asaasSubaccountId: updates.asaasSubaccountId || null,
    asaasConfigured:   !!updates.asaasApiKey,
    assinafyConfigured: !!updates.assinafyApiKey,
    message: 'Owner cadastrado com sucesso. Trial de 14 dias ativo.',
    ...(asaasError ? { asaasWarning: asaasError } : {}),
  };
}

async function handleSetupAsaas(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });

  const ownerData = ownerSnap.data();
  const masterKey = await getMasterAsaasKey(db);
  if (!masterKey) throw Object.assign(new Error('Chave master Asaas não configurada'), { status: 500 });

  const subaccount = await createAsaasSubaccount(masterKey, ownerData);

  await ownerSnap.ref.update({
    asaasApiKey:       subaccount.apiKey   || '',
    asaasSubaccountId: subaccount.walletId || subaccount.id || '',
  });

  return {
    ok: true,
    ownerId,
    asaasSubaccountId: subaccount.walletId || subaccount.id,
    asaasConfigured:   true,
  };
}

async function migrateCollection(db, collectionName, ownerId) {
  const allSnap = await db.collection(collectionName).limit(500).get();
  const docs = allSnap.docs.filter(d => !d.data().ownerId);
  if (docs.length === 0) return 0;
  const batch = db.batch();
  docs.forEach(doc => batch.update(doc.ref, { ownerId }));
  await batch.commit();
  return docs.length;
}

async function handleMigrate(db, body) {
  const { secret, ownerId } = body;
  if (secret !== process.env.MIGRATE_SECRET) throw Object.assign(new Error('Não autorizado'), { status: 403 });
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });

  const [users, contracts, charges] = await Promise.all([
    migrateCollection(db, 'users',     ownerId),
    migrateCollection(db, 'contracts', ownerId),
    migrateCollection(db, 'charges',   ownerId),
  ]);

  return { ok: true, migrated: { users, contracts, charges }, ownerId };
}

async function handleGet(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });
  const snap = await db.collection('owners').doc(ownerId).get();
  if (!snap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  const d = snap.data();
  return {
    ownerId: snap.id,
    name:   d.name,
    email:  d.email,
    plan:   d.plan,
    status: d.status,
    maxTenants:    d.maxTenants,
    maxProperties: d.maxProperties,
    asaasConfigured:    !!d.asaasApiKey,
    assinafyConfigured: !!d.assinafyApiKey,
    trialEndsAt:    d.trialEndsAt?.toDate?.()?.toISOString(),
    planActiveUntil: d.planActiveUntil?.toDate?.()?.toISOString(),
  };
}

const PLAN_PRICES = { trial: 0, basic: 49, pro: 99 };

async function findOrCreateBillingCustomer(masterKey, ownerData) {
  const search = await fetch(
    `https://api.asaas.com/v3/customers?email=${encodeURIComponent(ownerData.email)}&limit=1`,
    { headers: { 'access_token': masterKey } }
  );
  const searchJson = await search.json();
  if (searchJson.data?.length > 0) return searchJson.data[0].id;

  const cpfCnpj = (ownerData.cpfCnpj || '').replace(/\D/g, '');
  const phone   = (ownerData.phone   || '').replace(/\D/g, '');
  const body = { name: ownerData.name, email: ownerData.email };
  if (cpfCnpj) body.cpfCnpj     = cpfCnpj;
  if (phone)   body.mobilePhone = phone;

  const r = await fetch('https://api.asaas.com/v3/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': masterKey },
    body: JSON.stringify(body)
  });
  const customer = await r.json();
  if (!r.ok) throw new Error(`Asaas customer: ${JSON.stringify(customer)}`);
  return customer.id;
}

async function handleActivatePlan(db, body) {
  const { ownerId, plan = 'basic', billingType = 'PIX' } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  const ownerData = ownerSnap.data();

  const masterKey = await getMasterAsaasKey(db);
  if (!masterKey) throw Object.assign(new Error('Chave master Asaas não configurada'), { status: 500 });

  const value = PLAN_PRICES[plan] ?? 49;

  // Find or create customer in master Asaas account
  let customerId = ownerData.billingCustomerId
    || await findOrCreateBillingCustomer(masterKey, ownerData);

  // Cancel existing subscription if any
  if (ownerData.subscriptionId) {
    try {
      await fetch(`https://api.asaas.com/v3/subscriptions/${ownerData.subscriptionId}`, {
        method: 'DELETE',
        headers: { 'access_token': masterKey }
      });
    } catch (_) {}
  }

  // Next due date: tomorrow
  const nextDueDateStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const subResp = await fetch('https://api.asaas.com/v3/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': masterKey },
    body: JSON.stringify({
      customer:    customerId,
      billingType,
      value,
      nextDueDate: nextDueDateStr,
      cycle:       'MONTHLY',
      description: `LocarPay ${plan.charAt(0).toUpperCase() + plan.slice(1)} — ${ownerData.name}`
    })
  });
  const sub = await subResp.json();
  if (!subResp.ok) throw new Error(`Asaas subscription: ${JSON.stringify(sub)}`);

  const planActiveUntil = Timestamp.fromMillis(Date.now() + 32 * 24 * 60 * 60 * 1000);
  await ownerSnap.ref.update({
    plan,
    status:            'active',
    billingStatus:     'pending_payment',
    billingCustomerId: customerId,
    subscriptionId:    sub.id,
    planActiveUntil,
    nextPaymentDueDate: nextDueDateStr
  });

  return { ok: true, subscriptionId: sub.id, customerId, plan, nextDueDate: nextDueDateStr, value };
}

async function handleBillingStatus(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });
  const snap = await db.collection('owners').doc(ownerId).get();
  if (!snap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  const d = snap.data();
  return {
    ownerId: snap.id,
    plan:               d.plan,
    status:             d.status,
    billingStatus:      d.billingStatus      || null,
    subscriptionId:     d.subscriptionId     || null,
    planActiveUntil:    d.planActiveUntil?.toDate?.()?.toISOString()  || null,
    trialEndsAt:        d.trialEndsAt?.toDate?.()?.toISOString()      || null,
    nextPaymentDueDate: d.nextPaymentDueDate  || null
  };
}

async function handleAsaasWebhook(db, body) {
  const { event, payment } = body || {};
  if (!event || !payment?.subscription) return { ok: true, ignored: true };

  const snap = await db.collection('owners')
    .where('subscriptionId', '==', payment.subscription)
    .limit(1).get();
  if (snap.empty) return { ok: true, ignored: true };

  const ref = snap.docs[0].ref;

  if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
    const planActiveUntil = Timestamp.fromMillis(Date.now() + 32 * 24 * 60 * 60 * 1000);
    await ref.update({ status: 'active', billingStatus: 'paid', planActiveUntil });
    return { ok: true, event, action: 'plan_extended' };
  }
  if (event === 'PAYMENT_OVERDUE') {
    await ref.update({ billingStatus: 'overdue' });
    return { ok: true, event, action: 'marked_overdue' };
  }
  if (event === 'PAYMENT_DELETED' || event === 'SUBSCRIPTION_DELETED') {
    await ref.update({ status: 'suspended', billingStatus: 'cancelled' });
    return { ok: true, event, action: 'suspended' };
  }
  return { ok: true, event, ignored: true };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();
    const body = req.body || {};
    const { step } = body;

    // Asaas payment webhook (no step, has event field)
    if (!step && body.event) return res.status(200).json(await handleAsaasWebhook(db, body));

    if (step === 'register')       return res.status(201).json(await handleRegister(db, body));
    if (step === 'setup-asaas')    return res.status(200).json(await handleSetupAsaas(db, body));
    if (step === 'migrate')        return res.status(200).json(await handleMigrate(db, body));
    if (step === 'get')            return res.status(200).json(await handleGet(db, body));
    if (step === 'activate-plan')  return res.status(200).json(await handleActivatePlan(db, body));
    if (step === 'billing-status') return res.status(200).json(await handleBillingStatus(db, body));
    return res.status(400).json({ error: 'step inválido' });

  } catch (e) {
    console.error('locarpay-owner error:', e.message);
    return res.status(e.status || 500).json({ error: e.message, ...(e.ownerId ? { ownerId: e.ownerId } : {}) });
  }
}
