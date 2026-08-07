// GET  → serve admin HTML
// POST → superadmin API (requer x-admin-token do super admin)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth }                        from 'firebase-admin/auth';
import { getFirestore, Timestamp }        from 'firebase-admin/firestore';
import {
  setCorsHeaders, getClientIp,
  checkRateLimit, recordFailedAttempt, resetRateLimit,
  logAdminAccess, validateAdminInput,
} from '../lib/security.js';

const SUPER_ADMIN_EMAIL = 'denisfelicio20@gmail.com';

function initFirebase() {
  if (getApps().length) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT;
  if (!sa) throw new Error('ENV: service account não configurada (LOCARPAY_SERVICE_ACCOUNT / FIREBASE_SERVICE_ACCOUNT)');
  initializeApp({ credential: cert(JSON.parse(sa)) });
}

async function verifyAdmin(req) {
  const token = req.headers['x-admin-token'];
  if (!token) throw Object.assign(new Error('Token ausente'), { status: 401 });

  // Aceita senha direta via env var ADMIN_SECRET (sem Firebase)
  const secret = process.env.ADMIN_SECRET;
  if (secret) {
    if (token === secret) return { email: SUPER_ADMIN_EMAIL };
    throw Object.assign(new Error('Senha incorreta'), { status: 401 });
  }

  // Fallback: Firebase ID token (somente se ADMIN_SECRET não estiver configurado)
  try {
    const decoded = await getAuth().verifyIdToken(token);
    if (decoded.email !== SUPER_ADMIN_EMAIL)
      throw Object.assign(new Error('Acesso negado'), { status: 403 });
    return decoded;
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error('Token inválido'), { status: 401 });
  }
}

async function listOwners(db) {
  const snap = await db.collection('owners').orderBy('createdAt', 'desc').get();
  const owners = snap.docs.map(d => {
    const data = d.data();
    return {
      ownerId:            d.id,
      name:               data.name            || '',
      email:              data.email           || '',
      phone:              data.phone           || '',
      cpfCnpj:            data.cpfCnpj         || '',
      plan:               data.plan            || 'trial',
      status:             data.status          || 'trial',
      monthlyPrice:       data.monthlyPrice    || 0,
      maxTenants:         data.maxTenants      || 3,
      asaasConfigured:    !!data.asaasApiKey,
      asaasWarning:       data.asaasWarning       || null,
      asaasSubaccountId:  data.asaasSubaccountId  || null,
      assinafyConfigured: !!data.assinafyApiKey,
      trialEndsAt:        data.trialEndsAt?.toDate?.()?.toISOString()     || null,
      planActiveUntil:    data.planActiveUntil?.toDate?.()?.toISOString() || null,
      createdAt:          data.createdAt?.toDate?.()?.toISOString()       || null,
      subscriptionId:     data.subscriptionId  || null,
      billingStatus:      data.billingStatus   || null,
    };
  });
  return { owners, total: owners.length };
}

async function activateOwner(db, ownerId) {
  const ref = db.collection('owners').doc(ownerId);
  if (!(await ref.get()).exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  const planActiveUntil = Timestamp.fromMillis(Date.now() + 32 * 24 * 60 * 60 * 1000);
  await ref.update({ status: 'active', planActiveUntil });
  return { message: 'Imobiliária ativada com sucesso.' };
}

async function suspendOwner(db, ownerId) {
  const ref = db.collection('owners').doc(ownerId);
  if (!(await ref.get()).exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  await ref.update({ status: 'suspended' });
  return { message: 'Imobiliária suspensa.' };
}

async function deleteOwner(db, ownerId) {
  const ref = db.collection('owners').doc(ownerId);
  if (!(await ref.get()).exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  await ref.delete();
  return { message: 'Imobiliária excluída permanentemente.' };
}

async function setupAsaas(db, ownerId) {
  const r = await fetch('https://ilocarpay.com.br/api/locarpay-owner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: 'setup-asaas', ownerId })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Erro ao criar subconta Asaas');
  return { message: 'Subconta Asaas criada com sucesso.' };
}

async function getMasterAsaasKey(db) {
  try {
    const masterSnap = await db.collection('owners').doc('transgu-owner-001').get();
    if (masterSnap.exists && masterSnap.data().asaasApiKey) return masterSnap.data().asaasApiKey;
  } catch (_) {}
  const configSnap = await db.collection('config').doc('asaas').get();
  const key = configSnap.data()?.apiKey;
  if (!key) throw new Error('Chave Asaas master nao configurada');
  return key;
}

async function asaasPost(path, body, apiKey) {
  const r = await fetch(`https://api.asaas.com/v3${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas ${path}: ${JSON.stringify(json?.errors || json)}`);
  return json;
}

async function asaasGet(path, apiKey) {
  const r = await fetch(`https://api.asaas.com/v3${path}`, {
    headers: { 'access_token': apiKey }
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas ${path}: ${JSON.stringify(json?.errors || json)}`);
  return json;
}

async function createSubscription(db, ownerId, plan) {
  const ref  = db.collection('owners').doc(ownerId);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('Owner nao encontrado'), { status: 404 });

  const data = snap.data();
  const PLANS = {
    trial: { monthlyPrice: 0,  label: 'Trial'  },
    basic: { monthlyPrice: 49, label: 'Basic'  },
    pro:   { monthlyPrice: 99, label: 'Pro'    },
  };
  const selectedPlan = plan || data.plan || 'basic';
  const planInfo = PLANS[selectedPlan] || PLANS.basic;
  if (planInfo.monthlyPrice === 0) throw Object.assign(new Error('Plano trial nao gera assinatura paga'), { status: 400 });

  const masterKey = await getMasterAsaasKey(db);

  // Busca ou cria customer na conta master
  const searchR = await fetch(
    `https://api.asaas.com/v3/customers?email=${encodeURIComponent(data.email)}&limit=1`,
    { headers: { 'access_token': masterKey } }
  );
  const searchJson = await searchR.json();
  let customerId;
  if (searchJson.data?.length > 0) {
    customerId = searchJson.data[0].id;
  } else {
    const cpfCnpj = (data.cpfCnpj || '').replace(/\D/g, '');
    const phone   = (data.phone   || '').replace(/\D/g, '');
    const custBody = { name: data.name, email: data.email };
    if (cpfCnpj) custBody.cpfCnpj    = cpfCnpj;
    if (phone)   custBody.mobilePhone = phone;
    const cust = await asaasPost('/customers', custBody, masterKey);
    customerId = cust.id;
  }

  // Cancela assinatura anterior se existir
  if (data.subscriptionId) {
    try { await fetch(`https://api.asaas.com/v3/subscriptions/${data.subscriptionId}`, {
      method: 'DELETE', headers: { 'access_token': masterKey }
    }); } catch (_) {}
  }

  // Cria assinatura mensal PIX
  const nextDueDate = new Date();
  nextDueDate.setDate(nextDueDate.getDate() + 1);
  const sub = await asaasPost('/subscriptions', {
    customer:     customerId,
    billingType:  'PIX',
    value:        planInfo.monthlyPrice,
    nextDueDate:  nextDueDate.toISOString().slice(0, 10),
    cycle:        'MONTHLY',
    description:  `iLocarPay - Plano ${planInfo.label}`,
  }, masterKey);

  // Atualiza Firestore
  const { Timestamp } = await import('firebase-admin/firestore');
  const planActiveUntil = Timestamp.fromMillis(Date.now() + 32 * 24 * 60 * 60 * 1000);
  await ref.update({
    status:           'active',
    plan:             selectedPlan,
    monthlyPrice:     planInfo.monthlyPrice,
    subscriptionId:   sub.id,
    asaasCustomerId:  customerId,
    billingStatus:    'ACTIVE',
    planActiveUntil,
  });

  return {
    message:        `Assinatura ${planInfo.label} criada com sucesso.`,
    subscriptionId: sub.id,
    customerId,
    nextDueDate:    nextDueDate.toISOString().slice(0, 10),
    value:          planInfo.monthlyPrice,
  };
}

async function getSubscriptionStatus(db, ownerId) {
  const ref  = db.collection('owners').doc(ownerId);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('Owner nao encontrado'), { status: 404 });
  const data = snap.data();
  if (!data.subscriptionId) return { hasSubscription: false };
  const masterKey = await getMasterAsaasKey(db);
  try {
    const sub = await asaasGet(`/subscriptions/${data.subscriptionId}`, masterKey);
    return { hasSubscription: true, subscription: sub };
  } catch (e) {
    return { hasSubscription: false, error: e.message };
  }
}

async function cancelSubscription(db, ownerId) {
  const ref  = db.collection('owners').doc(ownerId);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('Owner nao encontrado'), { status: 404 });
  const data = snap.data();
  if (!data.subscriptionId) throw Object.assign(new Error('Nenhuma assinatura ativa'), { status: 400 });
  const masterKey = await getMasterAsaasKey(db);
  await fetch(`https://api.asaas.com/v3/subscriptions/${data.subscriptionId}`, {
    method: 'DELETE', headers: { 'access_token': masterKey }
  });
  await ref.update({ subscriptionId: null, billingStatus: 'CANCELLED', status: 'suspended' });
  return { message: 'Assinatura cancelada e imobiliaria suspensa.' };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res, { restrictToSite: true });
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return res.status(302).setHeader('Location', '/admin').end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip   = getClientIp(req);
  const body = req.body || {};

  // Config pública (sem auth) — apenas dados não-secretos para o cliente
  if (body.step === 'public-config') {
    return res.status(200).json({
      apiKey:     process.env.LOCARPAY_FIREBASE_API_KEY || '',
      authDomain: 'transgu-web-6d50f.firebaseapp.com',
      projectId:  'transgu-web-6d50f',
    });
  }

  // Validação de input antes de qualquer coisa
  const inputErr = validateAdminInput(body);
  if (inputErr) return res.status(400).json({ error: inputErr });

  // POST → superadmin API
  try {
    initFirebase();
    const db = getFirestore();

    // Rate limiting
    const rl = await checkRateLimit(db, ip);
    if (rl.blocked) return res.status(429).json({ error: rl.message });

    // Autenticação
    try {
      await verifyAdmin(req);
    } catch(authErr) {
      await recordFailedAttempt(db, ip);
      await logAdminAccess(db, { ip, success: false, detail: authErr.message });
      return res.status(authErr.status || 401).json({ error: authErr.message });
    }

    // Login bem-sucedido — reseta contador e loga
    await resetRateLimit(db, ip);
    await logAdminAccess(db, { ip, success: true, detail: body.step });

    const { step, ownerId } = body;

    if (step === 'list-owners')           return res.status(200).json(await listOwners(db));
    if (step === 'activate-owner')        return res.status(200).json(await activateOwner(db, ownerId));
    if (step === 'suspend-owner')         return res.status(200).json(await suspendOwner(db, ownerId));
    if (step === 'delete-owner')          return res.status(200).json(await deleteOwner(db, ownerId));
    if (step === 'setup-asaas')           return res.status(200).json(await setupAsaas(db, ownerId));
    if (step === 'create-subscription')   return res.status(200).json(await createSubscription(db, ownerId, body.plan));
    if (step === 'subscription-status')   return res.status(200).json(await getSubscriptionStatus(db, ownerId));
    if (step === 'cancel-subscription')   return res.status(200).json(await cancelSubscription(db, ownerId));

    return res.status(400).json({ error: 'step inválido' });
  } catch(e) {
    console.error('admin error:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
