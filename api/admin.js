// GET  → serve admin HTML
// POST → superadmin API (requer x-admin-token do super admin)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth }                        from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';
import {
  setCorsHeaders, getClientIp,
  checkRateLimit, recordFailedAttempt, resetRateLimit,
  logAdminAccess, validateAdminInput,
} from '../lib/security.js';

const SUPER_ADMIN_EMAIL = 'denisfelicio20@gmail.com';
const ASAAS_BASE = (process.env.ASAAS_API_URL || 'https://api.asaas.com/v3').replace(/\/$/, '');

function initFirebase() {
  if (getApps().length) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.ILOCARPAY_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT;
  if (!sa) throw new Error('ENV: service account não configurada (ILOCARPAY_SERVICE_ACCOUNT / FIREBASE_SERVICE_ACCOUNT)');
  initializeApp({ credential: cert(JSON.parse(sa)) });
}

async function verifyAdmin(req) {
  const token = req.headers['x-admin-token'];
  if (!token) throw Object.assign(new Error('Token ausente'), { status: 401 });

  // Aceita senha direta via env var ADMIN_SECRET
  const secret = process.env.ADMIN_SECRET;
  if (secret && token === secret) return { email: SUPER_ADMIN_EMAIL };

  // Aceita Firebase ID token do super admin
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

// ─── OTP 2FA ─────────────────────────────────────────────────────────────────

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail(otp) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email',
    port: 465,
    secure: true,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD },
  });
  await transporter.sendMail({
    from: '"iLocarPay" <denis@dlftech.com.br>',
    to:   SUPER_ADMIN_EMAIL,
    subject: 'Código de acesso Super Admin',
    html: `<p>Seu código de acesso é: <strong style="font-size:24px;letter-spacing:4px;">${otp}</strong></p>
           <p>Válido por 5 minutos. Não compartilhe com ninguém.</p>`,
  });
}

async function requestOtp(db, ip) {
  const otp     = generateOtp();
  const expires = Date.now() + 5 * 60 * 1000;
  await db.collection('_admin_otp').doc('current').set({ otp, expires, ip });
  await sendOtpEmail(otp);
  return { message: 'Código enviado para o e-mail do administrador.' };
}

async function verifyOtp(db, ip, code) {
  const snap = await db.collection('_admin_otp').doc('current').get();
  if (!snap.exists) throw Object.assign(new Error('Nenhum código ativo'), { status: 401 });
  const { otp, expires } = snap.data();
  if (Date.now() > expires) {
    await db.collection('_admin_otp').doc('current').delete();
    throw Object.assign(new Error('Código expirado'), { status: 401 });
  }
  if (code !== otp) throw Object.assign(new Error('Código incorreto'), { status: 401 });
  await db.collection('_admin_otp').doc('current').delete();
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────

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

async function deleteTenant(db, tenantId) {
  const auth = getAuth();

  // 1. Busca o documento do inquilino
  const userRef = db.collection('users').doc(tenantId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw Object.assign(new Error('Inquilino nao encontrado'), { status: 404 });

  const email = userSnap.data().email;

  // 2. Marca como suspenso — dispara listener em tempo real no app do inquilino
  await userRef.update({ suspended: true });

  // 3. Revoga tokens Firebase — invalida sessao em QUALQUER versao do app
  try {
    const fbUser = await auth.getUserByEmail(email);
    await auth.revokeRefreshTokens(fbUser.uid);
  } catch (_) {
    // Pode nao ter conta Firebase Auth — continua a exclusao
  }

  // 4. Deleta cobranças, contratos, leads e comissões do corretor
  const [charges, contracts, leads, commissions] = await Promise.all([
    db.collection('charges').where('tenantId', '==', tenantId).get(),
    db.collection('contracts').where('tenantId', '==', tenantId).get(),
    db.collection('leads').where('tenantId', '==', tenantId).get(),
    db.collection('commissions').where('tenantId', '==', tenantId).get(),
  ]);
  const batch = db.batch();
  charges.docs.forEach(d => batch.delete(d.ref));
  contracts.docs.forEach(d => batch.delete(d.ref));
  leads.docs.forEach(d => batch.delete(d.ref));
  commissions.docs.forEach(d => batch.delete(d.ref));
  batch.delete(userRef);
  await batch.commit();

  return { message: 'Inquilino removido e sessao invalidada.' };
}

async function setupAsaas(db, ownerId) {
  const r = await fetch('https://ilocarpay.com.br/api/ilocarpay-owner', {
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
  const r = await fetch(`${ASAAS_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas ${path}: ${JSON.stringify(json?.errors || json)}`);
  return json;
}

async function asaasGet(path, apiKey) {
  const r = await fetch(`${ASAAS_BASE}${path}`, {
    headers: { 'access_token': apiKey }
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas ${path}: ${JSON.stringify(json?.errors || json)}`);
  return json;
}

async function createSubscription(db, ownerId, plan) {
  const ref  = db.collection('owners').doc(ownerId);

  // Proteção contra race condition: tenta reservar atomicamente via transação
  let data;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error('Owner nao encontrado'), { status: 404 });
    data = snap.data();
    if (data._subPending) {
      const pendingAge = Date.now() - (data._subPending.toMillis?.() ?? 0);
      if (pendingAge < 5 * 60 * 1000) throw Object.assign(new Error('Criacao de assinatura ja em andamento'), { status: 409 });
    }
    tx.update(ref, { _subPending: Timestamp.now() });
  });

  const PLANS = {
    trial: { monthlyPrice: 0,  label: 'Trial'  },
    basic: { monthlyPrice: 49, label: 'Basic'  },
    pro:   { monthlyPrice: 99, label: 'Pro'    },
  };
  const selectedPlan = plan || data.plan || 'basic';
  const planInfo = PLANS[selectedPlan] || PLANS.basic;
  if (planInfo.monthlyPrice === 0) {
    await ref.update({ _subPending: FieldValue.delete() });
    throw Object.assign(new Error('Plano trial nao gera assinatura paga'), { status: 400 });
  }

  try {
    const masterKey = await getMasterAsaasKey(db);

    // Busca ou cria customer na conta master
    const searchR = await fetch(
      `${ASAAS_BASE}/customers?email=${encodeURIComponent(data.email)}&limit=1`,
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
      try {
        await fetch(`${ASAAS_BASE}/subscriptions/${data.subscriptionId}`, {
          method: 'DELETE', headers: { 'access_token': masterKey }
        });
      } catch (cancelErr) {
        console.error('[createSubscription] falha ao cancelar assinatura anterior', { ownerId, subscriptionId: data.subscriptionId, message: cancelErr.message });
      }
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

    const planActiveUntil = Timestamp.fromMillis(Date.now() + 32 * 24 * 60 * 60 * 1000);
    await ref.update({
      status:           'active',
      plan:             selectedPlan,
      monthlyPrice:     planInfo.monthlyPrice,
      subscriptionId:   sub.id,
      asaasCustomerId:  customerId,
      billingStatus:    'ACTIVE',
      planActiveUntil,
      _subPending:      FieldValue.delete(),
    });

    return {
      message:        `Assinatura ${planInfo.label} criada com sucesso.`,
      subscriptionId: sub.id,
      customerId,
      nextDueDate:    nextDueDate.toISOString().slice(0, 10),
      value:          planInfo.monthlyPrice,
    };
  } catch (err) {
    await ref.update({ _subPending: FieldValue.delete() }).catch(() => {});
    throw err;
  }
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
  await fetch(`${ASAAS_BASE}/subscriptions/${data.subscriptionId}`, {
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

  // Etapa 1: verifica senha e envia OTP (sem auth completa ainda)
  if (body.step === 'request-otp') {
    const rl = await (async () => {
      try { initFirebase(); return await checkRateLimit(getFirestore(), ip); } catch(_) { return { blocked: false }; }
    })();
    if (rl.blocked) return res.status(429).json({ error: rl.message });
    const secret = process.env.ADMIN_SECRET;
    const token  = req.headers['x-admin-token'] || '';
    if (!secret || token !== secret) {
      try { initFirebase(); await recordFailedAttempt(getFirestore(), ip); } catch(_) {}
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    try {
      initFirebase();
      const db = getFirestore();
      await requestOtp(db, ip);
      return res.status(200).json({ message: 'Código enviado para o e-mail do administrador.' });
    } catch(e) {
      return res.status(500).json({ error: 'Erro ao enviar código: ' + e.message });
    }
  }

  // Etapa 2: verifica OTP + emite sessão
  if (body.step === 'verify-otp') {
    const { code } = body;
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Código obrigatório' });
    try {
      initFirebase();
      const db = getFirestore();
      await verifyOtp(db, ip, code.trim());
      await resetRateLimit(db, ip);
      await logAdminAccess(db, { ip, success: true, detail: '2fa-otp' });
      return res.status(200).json({ ok: true });
    } catch(e) {
      try { await recordFailedAttempt(getFirestore(), ip); } catch(_) {}
      return res.status(e.status || 500).json({ error: e.message });
    }
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
    if (step === 'delete-tenant')         return res.status(200).json(await deleteTenant(db, body.tenantId));
    if (step === 'setup-asaas')           return res.status(200).json(await setupAsaas(db, ownerId));
    if (step === 'create-subscription')   return res.status(200).json(await createSubscription(db, ownerId, body.plan));
    if (step === 'subscription-status')   return res.status(200).json(await getSubscriptionStatus(db, ownerId));
    if (step === 'cancel-subscription')   return res.status(200).json(await cancelSubscription(db, ownerId));

    return res.status(400).json({ error: 'step invalido' });
  } catch(e) {
    console.error('admin error:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
