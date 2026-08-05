// POST /api/locarpay-owner
// step:"register"     â†’ { name, email, phone?, cpfCnpj?, companyType?, address?, addressNumber?, province?, postalCode?, plan?, firebaseUid? }
// step:"setup-asaas"  â†’ { ownerId } â†’ (re)cria subconta Asaas para owner existente
// step:"migrate"      â†’ { secret, ownerId } â†’ backfill ownerId em docs legados (requer MIGRATE_SECRET)
// step:"get"          â†’ { ownerId } â†’ retorna dados pÃºblicos do owner

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp }       from 'firebase-admin/firestore';
import nodemailer                         from 'nodemailer';

const PLANS = {
  trial: { maxTenants: 3,  maxProperties: 2,  monthlyPrice: 0   },
  basic: { maxTenants: 10, maxProperties: 5,  monthlyPrice: 49  },
  pro:   { maxTenants: 30, maxProperties: 20, monthlyPrice: 99  },
};

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

// LÃª a chave master Asaas (da conta principal)
async function getMasterAsaasKey(db) {
  // Tenta primeiro no owner master (transgu-owner-001), fallback para /config/asaas
  try {
    const masterSnap = await db.collection('owners').doc('transgu-owner-001').get();
    if (masterSnap.exists && masterSnap.data().asaasApiKey) return masterSnap.data().asaasApiKey;
  } catch (_) {}
  const configSnap = await db.collection('config').doc('asaas').get();
  return configSnap.data()?.apiKey;
}

// LÃª a chave Assinafy compartilhada (centralizada)
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
  if (!name || !email) throw Object.assign(new Error('name e email sÃ£o obrigatÃ³rios'), { status: 400 });

  const existing = await db.collection('owners').where('email', '==', email).limit(1).get();
  if (!existing.empty) {
    throw Object.assign(new Error('Email jÃ¡ cadastrado'), { status: 409, ownerId: existing.docs[0].id });
  }

  const now = Timestamp.now();
  const trialEndsAt = Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const planConfig = PLANS[plan] || PLANS.trial;

  const docRef = firebaseUid
    ? db.collection('owners').doc(firebaseUid)
    : db.collection('owners').doc();

  // Cria documento bÃ¡sico primeiro
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

  // Registra webhook de pagamento na subconta (fire-and-forget)
  if (updates.asaasApiKey) {
    handleSetupPaymentWebhook(db, { ownerId: docRef.id }).catch(() => {});
  }

  // E-mail de boas-vindas (fire-and-forget)
  try {
    const trialFmt = trialEndsAt.toDate().toLocaleDateString('pt-BR');
    const transporter = nodemailer.createTransport({
      host: 'smtp.titan.email', port: 587, secure: false,
      auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
    });
    await transporter.sendMail({
      from:    'iLocarPay <denis@dlftech.com.br>',
      to:      email,
      subject: 'Bem-vindo ao iLocarPay! ðŸŽ‰ Sua conta estÃ¡ pronta',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="background:#2e7d32;color:#fff;font-weight:800;font-size:18px;padding:6px 14px;border-radius:8px">iLocarPay</span>
          </div>
          <h2 style="color:#1a1a1a;margin-bottom:8px">Sua conta estÃ¡ pronta, ${name.split(' ')[0]}! ðŸŽ‰</h2>
          <p style="color:#555;line-height:1.7;margin-bottom:20px">
            Seu trial de <strong>14 dias grÃ¡tis</strong> foi ativado. VocÃª tem acesso completo ao iLocarPay atÃ© <strong>${trialFmt}</strong>.
          </p>
          <div style="background:#f0f7f0;border-radius:10px;padding:20px;margin-bottom:24px">
            <h3 style="color:#2e7d32;font-size:14px;margin-bottom:12px">ðŸ“‹ Primeiros passos</h3>
            <ol style="color:#555;line-height:2;padding-left:20px;margin:0">
              <li>Acesse o painel em <a href="https://ilocarpay.com.br/admin" style="color:#2e7d32">ilocarpay.com.br/admin</a></li>
              <li>Cadastre seus inquilinos com nome, e-mail e valor do aluguel</li>
              <li>Gere contratos digitais (assinatura eletrÃ´nica inclusa)</li>
              <li>Ative as cobranÃ§as automÃ¡ticas mensais com PIX</li>
            </ol>
          </div>
          <a href="https://ilocarpay.com.br/admin" style="display:inline-block;background:#4CAF50;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:24px">
            Acessar painel agora â†’
          </a>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px">
            DÃºvidas? Responda este e-mail ou acesse o painel em qualquer momento.<br>
            ID da sua conta: <code style="font-size:11px;color:#888">${docRef.id}</code>
          </p>
        </div>
      `
    });
  } catch (_) {} // falha no e-mail nÃ£o bloqueia cadastro

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
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatÃ³rio'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner nÃ£o encontrado'), { status: 404 });

  const ownerData = ownerSnap.data();
  const masterKey = await getMasterAsaasKey(db);
  if (!masterKey) throw Object.assign(new Error('Chave master Asaas nÃ£o configurada'), { status: 500 });

  const subaccount = await createAsaasSubaccount(masterKey, ownerData);

  const newApiKey = subaccount.apiKey || '';
  await ownerSnap.ref.update({
    asaasApiKey:       newApiKey,
    asaasSubaccountId: subaccount.walletId || subaccount.id || '',
  });

  // Registra webhook de pagamento na subconta recÃ©m-criada
  let webhookResult = null;
  if (newApiKey) {
    try {
      webhookResult = await handleSetupPaymentWebhook(db, { ownerId });
    } catch (_) {}
  }

  return {
    ok: true,
    ownerId,
    asaasSubaccountId: subaccount.walletId || subaccount.id,
    asaasConfigured:   true,
    webhookConfigured: !!webhookResult?.ok,
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
  if (secret !== process.env.MIGRATE_SECRET) throw Object.assign(new Error('NÃ£o autorizado'), { status: 403 });
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatÃ³rio'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner nÃ£o encontrado'), { status: 404 });

  const [users, contracts, charges] = await Promise.all([
    migrateCollection(db, 'users',     ownerId),
    migrateCollection(db, 'contracts', ownerId),
    migrateCollection(db, 'charges',   ownerId),
  ]);

  return { ok: true, migrated: { users, contracts, charges }, ownerId };
}

async function handleGet(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatÃ³rio'), { status: 400 });
  const snap = await db.collection('owners').doc(ownerId).get();
  if (!snap.exists) throw Object.assign(new Error('Owner nÃ£o encontrado'), { status: 404 });
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
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatÃ³rio'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner nÃ£o encontrado'), { status: 404 });
  const ownerData = ownerSnap.data();

  const masterKey = await getMasterAsaasKey(db);
  if (!masterKey) throw Object.assign(new Error('Chave master Asaas nÃ£o configurada'), { status: 500 });

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
      description: `iLocarPay ${plan.charAt(0).toUpperCase() + plan.slice(1)} â€” ${ownerData.name}`
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
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatÃ³rio'), { status: 400 });
  const snap = await db.collection('owners').doc(ownerId).get();
  if (!snap.exists) throw Object.assign(new Error('Owner nÃ£o encontrado'), { status: 404 });
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

async function handleSetupWebhook(db, body) {
  const { secret } = body;
  if (secret !== process.env.MIGRATE_SECRET) throw Object.assign(new Error('NÃ£o autorizado'), { status: 403 });

  const masterKey = await getMasterAsaasKey(db);
  if (!masterKey) throw Object.assign(new Error('Chave master Asaas nÃ£o encontrada'), { status: 500 });

  const webhookUrl = 'https://ilocarpay.com.br/billing-webhook';
  const events = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', 'SUBSCRIPTION_DELETED'];

  // Lista webhooks existentes para evitar duplicata
  const listResp = await fetch('https://api.asaas.com/v3/webhooks', {
    headers: { 'access_token': masterKey }
  });
  const listJson = await listResp.json();
  const existing = (listJson.data || []).find(w => w.url === webhookUrl);

  if (existing) {
    // Atualiza para garantir que os eventos estÃ£o corretos
    const updResp = await fetch(`https://api.asaas.com/v3/webhooks/${existing.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'access_token': masterKey },
      body: JSON.stringify({ url: webhookUrl, enabled: true, events })
    });
    const upd = await updResp.json();
    if (!updResp.ok) throw new Error(`Asaas webhook update: ${JSON.stringify(upd)}`);
    await db.collection('config').doc('asaas-webhook').set({ webhookId: upd.id, url: webhookUrl, events, updatedAt: Timestamp.now() });
    return { ok: true, action: 'updated', webhookId: upd.id, url: webhookUrl, events };
  }

  // Cria novo webhook
  const createResp = await fetch('https://api.asaas.com/v3/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': masterKey },
    body: JSON.stringify({ name: 'iLocarPay Billing', url: webhookUrl, email: 'contatotransgu@gmail.com', enabled: true, interrupted: false, type: 'PAYMENT', sendType: 'NON_SEQUENTIALLY', events })
  });
  const created = await createResp.json();
  if (!createResp.ok) throw new Error(`Asaas webhook create: ${JSON.stringify(created)}`);
  await db.collection('config').doc('asaas-webhook').set({ webhookId: created.id, url: webhookUrl, events, createdAt: Timestamp.now() });
  return { ok: true, action: 'created', webhookId: created.id, url: webhookUrl, events };
}

async function handleNotifyTrial(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatÃ³rio'), { status: 400 });

  const snap = await db.collection('owners').doc(ownerId).get();
  if (!snap.exists) throw Object.assign(new Error('Owner nÃ£o encontrado'), { status: 404 });
  const d = snap.data();

  // Evita reenvio em menos de 20h
  const lastNotified = d.trialNotifiedAt?.toMillis?.() || 0;
  if (Date.now() - lastNotified < 20 * 60 * 60 * 1000) {
    return { ok: true, skipped: true, reason: 'already_notified_recently' };
  }

  const trialEnd = d.trialEndsAt?.toDate?.();
  const daysLeft = trialEnd
    ? Math.ceil((trialEnd.getTime() - Date.now()) / 86400000)
    : null;

  // SÃ³ notifica se trial estÃ¡ expirando em â‰¤ 5 dias ou jÃ¡ expirou
  if (daysLeft !== null && daysLeft > 5) {
    return { ok: true, skipped: true, reason: 'too_early' };
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });

  const subject = daysLeft !== null && daysLeft <= 0
    ? 'Seu trial LocarPay expirou â€” ative um plano'
    : `Seu trial LocarPay expira em ${daysLeft} dia${daysLeft !== 1 ? 's' : ''}`;

  const urgencyMsg = daysLeft !== null && daysLeft <= 0
    ? 'Seu perÃ­odo de trial <strong>jÃ¡ expirou</strong>. Para continuar usando o LocarPay e receber pagamentos dos seus inquilinos, ative um plano.'
    : `Seu perÃ­odo de trial expira em <strong>${daysLeft} dia${daysLeft !== 1 ? 's' : ''}</strong>. Ative um plano para nÃ£o perder o acesso.`;

  await transporter.sendMail({
    from: 'LocarPay <denis@dlftech.com.br>',
    to: d.email,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
          <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
          <span style="font-size:18px;font-weight:700;color:#1a1a1a">LocarPay</span>
        </div>
        <h2 style="color:#1a1a1a;font-size:22px;margin-bottom:12px">${subject}</h2>
        <p style="color:#555;line-height:1.7;margin-bottom:20px">OlÃ¡, <strong>${d.name || d.email}</strong>!</p>
        <p style="color:#555;line-height:1.7;margin-bottom:28px">${urgencyMsg}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px">
          <div style="background:#f0f7f0;border:1px solid #c8e6c9;border-radius:10px;padding:16px 20px;flex:1;min-width:140px">
            <div style="font-size:13px;color:#555;margin-bottom:4px">Basic</div>
            <div style="font-size:24px;font-weight:800;color:#2D6A2D">R$49<span style="font-size:14px;font-weight:400">/mÃªs</span></div>
            <div style="font-size:12px;color:#888">atÃ© 10 inquilinos</div>
          </div>
          <div style="background:#f0f7f0;border:2px solid #4CAF50;border-radius:10px;padding:16px 20px;flex:1;min-width:140px">
            <div style="font-size:13px;color:#555;margin-bottom:4px">Pro â­</div>
            <div style="font-size:24px;font-weight:800;color:#2D6A2D">R$99<span style="font-size:14px;font-weight:400">/mÃªs</span></div>
            <div style="font-size:12px;color:#888">atÃ© 30 inquilinos</div>
          </div>
        </div>
        <a href="https://ilocarpay.com.br/admin" style="display:inline-block;background:#4CAF50;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:24px">
          Ativar plano agora â†’
        </a>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px">DÃºvidas? Responda este e-mail ou acesse o painel em ilocarpay.com.br/admin</p>
      </div>
    `
  });

  await snap.ref.update({ trialNotifiedAt: Timestamp.now() });
  return { ok: true, notified: true, email: d.email };
}

// â”€â”€ CRON DIÃRIO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Chamado pelo Vercel Cron (GET) todo dia Ã s 08:00 BRT (11:00 UTC)
// Executa para todos os owners ativos: mark-overdue, generate-charges, notify-upcoming
// No dia 1: envia relatÃ³rio mensal. Para trial: verifica notificaÃ§Ã£o de expiraÃ§Ã£o.
// Registra webhook de pagamento na subconta Asaas do owner
// URL: https://ilocarpay.com.br/payment-webhook
async function handleSetupPaymentWebhook(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatÃ³rio'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner nÃ£o encontrado'), { status: 404 });

  const apiKey = ownerSnap.data().asaasApiKey;
  if (!apiKey) throw Object.assign(new Error('Owner sem chave Asaas configurada'), { status: 400 });

  const webhookUrl = 'https://ilocarpay.com.br/payment-webhook';
  const events = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED'];

  // Checa webhooks existentes
  const listResp = await fetch('https://api.asaas.com/v3/webhooks', {
    headers: { 'access_token': apiKey }
  });
  const listJson = await listResp.json();
  const existing = (listJson.data || []).find(w => w.url === webhookUrl);

  if (existing) {
    const updResp = await fetch(`https://api.asaas.com/v3/webhooks/${existing.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
      body: JSON.stringify({ url: webhookUrl, enabled: true, events })
    });
    const upd = await updResp.json();
    await ownerSnap.ref.update({ paymentWebhookId: upd.id || existing.id });
    return { ok: true, action: 'updated', webhookId: upd.id || existing.id };
  }

  const createResp = await fetch('https://api.asaas.com/v3/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
    body: JSON.stringify({
      name: 'iLocarPay Pagamentos',
      url: webhookUrl,
      email: ownerSnap.data().email,
      enabled: true,
      interrupted: false,
      type: 'PAYMENT',
      sendType: 'NON_SEQUENTIALLY',
      events
    })
  });
  const created = await createResp.json();
  if (!createResp.ok) throw new Error(`Asaas webhook: ${JSON.stringify(created)}`);
  await ownerSnap.ref.update({ paymentWebhookId: created.id });
  return { ok: true, action: 'created', webhookId: created.id };
}

async function handleCronDaily(db) {
  const BASE = 'https://ilocarpay.com.br/api/locarpay-card';
  const OWNER_URL = 'https://ilocarpay.com.br/api/locarpay-owner';

  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json()).catch(e => ({ error: e.message }));

  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const isFirstOfMonth = dayOfMonth === 1;
  const isEndOfMonth   = dayOfMonth >= 26;

  const ownersSnap = await db.collection('owners').get();
  const results = {};

  await Promise.all(ownersSnap.docs.map(async ownerDoc => {
    const ownerId = ownerDoc.id;
    const d = ownerDoc.data();
    if (d.status === 'suspended') return;

    const ops = [];

    // 1. Marca cobranÃ§as vencidas + calcula multa/juros
    ops.push(post(BASE, { step: 'mark-overdue', ownerId }));

    // 2. Gera cobranÃ§as: mÃªs atual nos primeiros 3 dias, prÃ³ximo mÃªs nos Ãºltimos 5
    if (dayOfMonth <= 3)  ops.push(post(BASE, { step: 'generate-charges', ownerId, monthOffset: 0 }));
    if (isEndOfMonth)     ops.push(post(BASE, { step: 'generate-charges', ownerId, monthOffset: 1 }));

    // 3. Avisa vencimentos em 3 dias
    ops.push(post(BASE, { step: 'notify-upcoming', ownerId, daysAhead: 3 }));

    // 4. RelatÃ³rio mensal no dia 1 (mÃªs anterior)
    if (isFirstOfMonth) {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const monthStr = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
      ops.push(post(BASE, { step: 'monthly-report', ownerId, month: monthStr }));
    }

    // 5. Notifica trial expirando (a cada atÃ© 20h, controlado internamente)
    if (d.status === 'trial' || !d.status) {
      ops.push(post(OWNER_URL, { step: 'notify-trial', ownerId }));
    }

    const settled = await Promise.all(ops);
    results[ownerId] = settled;
  }));

  return { ok: true, ran: now.toISOString(), owners: ownersSnap.size, results };
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vercel Cron: GET com header x-vercel-cron
  if (req.method === 'GET') {
    if (!req.headers['x-vercel-cron']) return res.status(401).json({ error: 'Unauthorized' });
    try {
      initFirebase();
      const db = getFirestore();
      return res.status(200).json(await handleCronDaily(db));
    } catch (e) {
      console.error('cron-daily error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

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
    if (step === 'notify-trial')   return res.status(200).json(await handleNotifyTrial(db, body));
    if (step === 'setup-webhook')          return res.status(200).json(await handleSetupWebhook(db, body));
    if (step === 'setup-payment-webhook')  return res.status(200).json(await handleSetupPaymentWebhook(db, body));
    return res.status(400).json({ error: 'step invÃ¡lido' });

  } catch (e) {
    console.error('locarpay-owner error:', e.message);
    return res.status(e.status || 500).json({ error: e.message, ...(e.ownerId ? { ownerId: e.ownerId } : {}) });
  }
}

