// POST /api/locarpay-card
// step:"init"    → { tenantId, chargeId, card } → cobra micro-valor, retorna { verificationId }
// step:"confirm" → { verificationId, amount }   → verifica valor, estorna micro, cobra aluguel

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getMessaging }                  from 'firebase-admin/messaging';
import { getAsaasKey, getDefaultOwnerId, checkOwnerPlanActive } from '../lib/owner.js';
import nodemailer                         from 'nodemailer';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

async function asaasReq(method, path, body, apiKey) {
  const r = await fetch(`https://api.asaas.com/v3${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas ${path} ${r.status}: ${JSON.stringify(json)}`);
  return json;
}

async function findOrCreateCustomer(name, email, cpf, phone, apiKey) {
  const cpfDigits   = (cpf   || '').replace(/\D/g, '');
  const phoneDigits = (phone || '').replace(/\D/g, '');

  const search = await fetch(
    `https://api.asaas.com/v3/customers?email=${encodeURIComponent(email)}&limit=1`,
    { headers: { 'access_token': apiKey } }
  );
  const { data } = await search.json();
  if (data?.length > 0) {
    const existing = data[0];
    const needsUpdate = (!existing.cpfCnpj && cpfDigits.length === 11)
                     || (!existing.mobilePhone && phoneDigits.length >= 10);
    if (needsUpdate) {
      const patch = { name: existing.name };
      if (!existing.cpfCnpj   && cpfDigits.length === 11)   patch.cpfCnpj     = cpfDigits;
      if (!existing.mobilePhone && phoneDigits.length >= 10) patch.mobilePhone = phoneDigits;
      await fetch(`https://api.asaas.com/v3/customers/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
        body: JSON.stringify(patch)
      });
    }
    return existing.id;
  }
  const body = { name: name || email.split('@')[0], email };
  if (cpfDigits.length === 11)   body.cpfCnpj     = cpfDigits;
  if (phoneDigits.length >= 10)  body.mobilePhone  = phoneDigits;
  const c = await asaasReq('POST', '/customers', body, apiKey);
  return c.id;
}

// ── INIT ────────────────────────────────────────────────────────────────────
async function handleInit(db, body, apiKey) {
  const { tenantId, chargeId, card, savedCardId } = body;
  if (!tenantId || !chargeId)
    throw Object.assign(new Error('tenantId e chargeId obrigatórios'), { status: 400 });

  let holderName, number, expiryMonth, expiryYear, ccv, postalCode, addressNumber;
  let usingSavedCard = false;
  let savedCardFallback = null;
  let savedToken = null;

  if (savedCardId) {
    // Usa cartão salvo
    const savedSnap = await db.collection('users').doc(tenantId).collection('savedCards').doc(savedCardId).get();
    if (!savedSnap.exists) throw Object.assign(new Error('Cartão salvo não encontrado'), { status: 404 });
    const sc = savedSnap.data();
    holderName   = sc.holderName;
    expiryMonth  = sc.expiryMonth;
    expiryYear   = sc.expiryYear;
    savedToken   = sc.cardToken || null;
    savedCardFallback = sc.cardFallback || null;
    usingSavedCard = true;
    // Se temos token, não precisamos de number/ccv
    if (!savedToken && !savedCardFallback)
      throw Object.assign(new Error('Dados do cartão salvo incompletos'), { status: 400 });
    if (savedCardFallback) {
      number      = savedCardFallback.number;
      ccv         = savedCardFallback.ccv;
      postalCode  = savedCardFallback.postalCode;
      addressNumber = savedCardFallback.addressNumber;
    }
  } else {
    if (!card) throw Object.assign(new Error('card obrigatório'), { status: 400 });
    ({ holderName, number, expiryMonth, expiryYear, ccv, postalCode, addressNumber } = card);
    if (!holderName || !number || !expiryMonth || !expiryYear || !ccv)
      throw Object.assign(new Error('Dados do cartão incompletos'), { status: 400 });
  }

  const [userSnap, chargeSnap] = await Promise.all([
    db.collection('users').doc(tenantId).get(),
    db.collection('charges').doc(chargeId).get(),
  ]);
  if (!userSnap.exists)   throw Object.assign(new Error('Inquilino não encontrado'), { status: 404 });
  if (!chargeSnap.exists) throw Object.assign(new Error('Cobrança não encontrada'),  { status: 404 });

  const ownerId = chargeSnap.data().ownerId || await getDefaultOwnerId(db);
  apiKey = apiKey || await getAsaasKey(db, ownerId);
  if (!apiKey) throw Object.assign(new Error('Chave Asaas não configurada'), { status: 500 });

  // Validação cruzada: inquilino deve pertencer ao mesmo owner da cobrança
  const userOwnerId = userSnap.data().ownerId;
  if (userOwnerId && ownerId && userOwnerId !== ownerId) {
    throw Object.assign(new Error('Acesso negado: cobrança não pertence a este inquilino'), { status: 403 });
  }

  const user   = userSnap.data();
  const cpf    = (user.cpf || '').replace(/\D/g, '');
  const email  = user.email || '';
  const name   = user.name  || email.split('@')[0] || 'Inquilino';
  const phone  = (user.phone || '').replace(/\D/g, '');

  if (cpf.length !== 11)
    throw Object.assign(new Error('CPF do inquilino não cadastrado. Peça ao administrador.'), { status: 400 });

  const customerId = await findOrCreateCustomer(name, email, cpf, phone, apiKey);

  // Valor aleatório entre R$5,01 e R$9,99 (mínimo Asaas = R$5,00)
  const microValue = parseFloat((5 + Math.random() * 4.98).toFixed(2));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = tomorrow.toISOString().slice(0, 10);

  const holderInfoBase = {
    name:          holderName,
    email,
    cpfCnpj:       cpf,
    postalCode:    (postalCode || '').replace(/\D/g, '') || '00000000',
    addressNumber: addressNumber || 'SN',
    phone:         phone || '11999999999'
  };

  let chargeBody;
  if (savedToken) {
    chargeBody = {
      customer:    customerId,
      billingType: 'CREDIT_CARD',
      value:       microValue,
      dueDate,
      description: 'Verificacao de cartao LocarPay',
      creditCardToken:      savedToken,
      creditCardHolderInfo: holderInfoBase
    };
  } else {
    chargeBody = {
      customer:    customerId,
      billingType: 'CREDIT_CARD',
      value:       microValue,
      dueDate,
      description: 'Verificacao de cartao LocarPay',
      creditCard: {
        holderName,
        number:      number.replace(/\D/g, ''),
        expiryMonth: expiryMonth.padStart(2, '0'),
        expiryYear:  expiryYear.length === 2 ? `20${expiryYear}` : expiryYear,
        ccv
      },
      creditCardHolderInfo: holderInfoBase
    };
  }

  const asaasCharge = await asaasReq('POST', '/payments', chargeBody, apiKey);
  const cardToken   = asaasCharge.creditCard?.creditCardToken || savedToken || null;
  const lastFour    = asaasCharge.creditCard?.creditCardNumber?.slice(-4) || '';
  const cardBrand   = asaasCharge.creditCard?.creditCardBrand || '';

  // Cancela a micro-cobrança imediatamente — o cliente nunca vê a cobrança
  try {
    await asaasReq('POST', `/payments/${asaasCharge.id}/cancel`, {}, apiKey);
  } catch (_) { /* se já capturada, tenta estornar */ }

  const verRef = db.collection('cardVerifications').doc();
  const expMonth = expiryMonth ? expiryMonth.padStart(2, '0') : (savedCardFallback?.expiryMonth || '');
  const expYear  = expiryYear  ? (expiryYear.length === 2 ? `20${expiryYear}` : expiryYear) : (savedCardFallback?.expiryYear || '');

  const verData = {
    tenantId,
    chargeId,
    customerId,
    cardToken,
    lastFour,
    cardBrand,
    holderName,
    expiryMonth:    expMonth,
    expiryYear:     expYear,
    postalCode:     (postalCode || '').replace(/\D/g, ''),
    addressNumber:  addressNumber || 'SN',
    verified:       false,
    createdAt:      FieldValue.serverTimestamp(),
    expiresAt:      new Date(Date.now() + 24 * 60 * 60 * 1000)
  };

  // Guarda fallback apenas se não temos token
  if (!cardToken) {
    verData.cardFallback = savedCardFallback || {
      holderName,
      number:        number.replace(/\D/g, ''),
      expiryMonth:   expMonth,
      expiryYear:    expYear,
      ccv,
      postalCode:    (postalCode || '').replace(/\D/g, ''),
      addressNumber: addressNumber || 'SN'
    };
  }

  await verRef.set(verData);

  return { verificationId: verRef.id, lastFour, cardBrand };
}

// ── CONFIRM ──────────────────────────────────────────────────────────────────
async function handleConfirm(db, body) {
  const { verificationId } = body;
  if (!verificationId)
    throw Object.assign(new Error('verificationId obrigatório'), { status: 400 });

  const verRef  = db.collection('cardVerifications').doc(verificationId);
  const verSnap = await verRef.get();
  if (!verSnap.exists) throw Object.assign(new Error('Verificação não encontrada'), { status: 404 });

  const ver = verSnap.data();

  if (ver.verified)
    throw Object.assign(new Error('Cartão já verificado'), { status: 400 });

  if (new Date() > ver.expiresAt.toDate())
    throw Object.assign(new Error('Verificação expirada. Recadastre o cartão.'), { status: 400 });

  // Cobra o aluguel real
  const chargeSnap = await db.collection('charges').doc(ver.chargeId).get();
  const charge = chargeSnap.data();

  const ownerId = charge.ownerId || await getDefaultOwnerId(db);
  const [apiKey, ownerSnap] = await Promise.all([
    getAsaasKey(db, ownerId),
    db.collection('owners').doc(ownerId).get(),
  ]);
  if (!apiKey) throw Object.assign(new Error('Chave Asaas não configurada'), { status: 500 });
  const configData = ownerSnap.exists ? ownerSnap.data() : {};

  // Taxa do cartão repassada ao inquilino (padrão 2.99% + R$0.49 fixo)
  const cardFeeRate  = (configData.cardFeePercentage ?? 2.99) / 100;
  const cardFeeFixed = configData.cardFeeFixed ?? 0.49;

  // Juros/multa por atraso
  const baseValue   = charge.totalAmount || charge.baseRent || 5;
  const dueDateObj  = charge.dueDate?.toDate ? charge.dueDate.toDate() : new Date(charge.dueDate?.seconds * 1000);
  const today       = new Date(); today.setHours(0, 0, 0, 0);
  const dueDateOnly = new Date(dueDateObj); dueDateOnly.setHours(0, 0, 0, 0);
  const diasAtraso  = Math.max(0, Math.floor((today - dueDateOnly) / 86400000));

  const finePercentage = (configData.finePercentage ?? 2) / 100;
  const interestRate   = (configData.interestRate   ?? 1) / 100 / 30; // ao dia

  let valueComAtraso = baseValue;
  if (diasAtraso > 0) {
    valueComAtraso = baseValue * (1 + finePercentage + interestRate * diasAtraso);
    valueComAtraso = parseFloat(valueComAtraso.toFixed(2));
  }

  // Adiciona taxa do cartão em cima do valor (com atraso, se houver)
  const value = parseFloat(((valueComAtraso + cardFeeFixed) / (1 - cardFeeRate)).toFixed(2));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate  = tomorrow.toISOString().slice(0, 10);

  const userSnap2 = await db.collection('users').doc(ver.tenantId).get();
  const cpfConfirm = (userSnap2.data()?.cpf || '').replace(/\D/g, '');
  const emailConfirm = userSnap2.data()?.email || '';
  const phoneConfirm = (userSnap2.data()?.phone || '').replace(/\D/g, '') || '11999999999';

  let asaasRealCharge;
  if (ver.cardToken) {
    // Usa token — sem precisar dos dados do cartão de novo
    asaasRealCharge = await asaasReq('POST', '/payments', {
      customer:            ver.customerId,
      billingType:         'CREDIT_CARD',
      value,
      dueDate,
      description:         `Aluguel ${dueDate.slice(0, 7)}`,
      creditCardToken:     ver.cardToken,
      creditCardHolderInfo: {
        name:    ver.holderName,
        email:   emailConfirm,
        cpfCnpj: cpfConfirm,
        postalCode:    ver.postalCode || '00000000',
        addressNumber: ver.addressNumber || 'SN',
        phone:   phoneConfirm
      }
    }, apiKey);
  } else if (ver.cardFallback) {
    // Fallback: re-envia dados do cartão armazenados temporariamente
    const fb = ver.cardFallback;
    asaasRealCharge = await asaasReq('POST', '/payments', {
      customer:    ver.customerId,
      billingType: 'CREDIT_CARD',
      value,
      dueDate,
      description: `Aluguel ${dueDate.slice(0, 7)}`,
      creditCard: {
        holderName:  fb.holderName,
        number:      fb.number,
        expiryMonth: fb.expiryMonth,
        expiryYear:  fb.expiryYear,
        ccv:         fb.ccv
      },
      creditCardHolderInfo: {
        name:          fb.holderName,
        email:         emailConfirm,
        cpfCnpj:       cpfConfirm,
        postalCode:    fb.postalCode || '00000000',
        addressNumber: fb.addressNumber || 'SN',
        phone:         phoneConfirm
      }
    }, apiKey);
  } else {
    throw new Error('Dados do cartão não disponíveis. Recadastre o cartão.');
  }

  const paid = ['CONFIRMED','RECEIVED'].includes(asaasRealCharge.status);

  // Tenta extrair token do cartão da resposta real (para salvar)
  const realToken = asaasRealCharge.creditCard?.creditCardToken || ver.cardToken || null;
  const lastFour  = asaasRealCharge.creditCard?.creditCardNumber?.slice(-4) || ver.cardFallback?.number?.slice(-4) || '';
  const brand     = asaasRealCharge.creditCard?.creditCardBrand || '';

  const ops = [
    db.collection('charges').doc(ver.chargeId).update({
      asaasChargeId: asaasRealCharge.id,
      status:        paid ? 'paid' : 'under_review',
      ...(paid ? { paidAt: FieldValue.serverTimestamp() } : {})
    }),
    verRef.update({ verified: true, paidAt: FieldValue.serverTimestamp(), cardFallback: FieldValue.delete() })
  ];

  // Salvar cartão se solicitado
  if (body.saveCard && paid) {
    const savedCardData = {
      holderName:  ver.cardFallback?.holderName || ver.holderName,
      lastFour,
      brand,
      expiryMonth: ver.cardFallback?.expiryMonth || ver.expiryMonth,
      expiryYear:  ver.cardFallback?.expiryYear  || ver.expiryYear,
      createdAt:   FieldValue.serverTimestamp()
    };
    if (realToken) {
      savedCardData.cardToken = realToken;
    } else if (ver.cardFallback) {
      savedCardData.cardFallback = ver.cardFallback;
    }
    ops.push(db.collection('users').doc(ver.tenantId).collection('savedCards').add(savedCardData));
  }

  await Promise.all(ops);

  return {
    paid,
    status:     asaasRealCharge.status,
    message:    paid ? 'Pagamento aprovado!' : 'Pagamento em análise.',
    baseValue,
    totalCharged: value,
    diasAtraso,
    cardFee: parseFloat((value - valueComAtraso).toFixed(2))
  };
}

// ── LIST SAVED CARDS ─────────────────────────────────────────────────────────
async function handleListSaved(db, body) {
  const { tenantId } = body;
  if (!tenantId) throw Object.assign(new Error('tenantId obrigatório'), { status: 400 });
  const snap = await db.collection('users').doc(tenantId).collection('savedCards')
    .orderBy('createdAt', 'desc').limit(5).get();
  const cards = snap.docs.map(d => ({
    id:         d.id,
    holderName: d.data().holderName,
    lastFour:   d.data().lastFour,
    brand:      d.data().brand,
    expiryMonth:d.data().expiryMonth,
    expiryYear: d.data().expiryYear
  }));
  return { cards };
}

// ── DELETE SAVED CARD ─────────────────────────────────────────────────────────
async function handleDeleteSaved(db, body) {
  const { tenantId, savedCardId } = body;
  if (!tenantId || !savedCardId) throw Object.assign(new Error('tenantId e savedCardId obrigatórios'), { status: 400 });
  await db.collection('users').doc(tenantId).collection('savedCards').doc(savedCardId).delete();
  return { ok: true };
}

// ── REFUND ────────────────────────────────────────────────────────────────────
async function handleRefund(db, body) {
  const { chargeId } = body;
  if (!chargeId) throw Object.assign(new Error('chargeId obrigatório'), { status: 400 });

  const chargeSnap = await db.collection('charges').doc(chargeId).get();
  if (!chargeSnap.exists) throw Object.assign(new Error('Cobrança não encontrada'), { status: 404 });

  const charge = chargeSnap.data();
  const ownerId = charge.ownerId || await getDefaultOwnerId(db);
  const apiKey = await getAsaasKey(db, ownerId);
  if (!apiKey) throw Object.assign(new Error('Chave Asaas não configurada'), { status: 500 });

  if (!charge.asaasChargeId) {
    throw Object.assign(
      new Error('Cobrança sem ID de transação Asaas — estorno não é possível'),
      { status: 400 }
    );
  }

  const txId = charge.asaasChargeId;
  await asaasReq('POST', `/payments/${txId}/refunds`, {}, apiKey);

  await db.collection('charges').doc(chargeId).update({
    status:        'pending',
    asaasChargeId: '',
    pixCopyPaste:  '',
    pixQrCode:     '',
    paidAt:        null,
    refundedAt:    new Date(),
    refundNote:    `estornado via Asaas (ID: ${txId})`
  });

  return { ok: true, message: `Estorno solicitado com sucesso`, asaasChargeId: txId };
}

// ── PREVIEW VALORES ──────────────────────────────────────────────────────────
async function handlePreview(db, body) {
  const { chargeId } = body;
  if (!chargeId) throw Object.assign(new Error('chargeId obrigatório'), { status: 400 });

  const chargeSnap = await db.collection('charges').doc(chargeId).get();
  if (!chargeSnap.exists) throw Object.assign(new Error('Cobrança não encontrada'), { status: 404 });

  const charge = chargeSnap.data();
  const ownerId = charge.ownerId || await getDefaultOwnerId(db);
  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  const cfg = ownerSnap.exists ? ownerSnap.data() : {};

  const cardFeeRate  = (cfg.cardFeePercentage ?? 2.99) / 100;
  const cardFeeFixed = cfg.cardFeeFixed ?? 0.49;
  const finePercentage = (cfg.finePercentage ?? 2) / 100;
  const interestRate   = (cfg.interestRate   ?? 1) / 100 / 30;

  const baseValue   = charge.totalAmount || charge.baseRent || 5;
  const dueDateObj  = charge.dueDate?.toDate ? charge.dueDate.toDate() : new Date(charge.dueDate?.seconds * 1000);
  const today       = new Date(); today.setHours(0, 0, 0, 0);
  const dueDateOnly = new Date(dueDateObj); dueDateOnly.setHours(0, 0, 0, 0);
  const diasAtraso  = Math.max(0, Math.floor((today - dueDateOnly) / 86400000));

  let valueComAtraso = baseValue;
  let multa = 0, juros = 0;
  if (diasAtraso > 0) {
    multa = parseFloat((baseValue * finePercentage).toFixed(2));
    juros = parseFloat((baseValue * interestRate * diasAtraso).toFixed(2));
    valueComAtraso = parseFloat((baseValue + multa + juros).toFixed(2));
  }

  const totalCartao = parseFloat(((valueComAtraso + cardFeeFixed) / (1 - cardFeeRate)).toFixed(2));
  const taxaCartao  = parseFloat((totalCartao - valueComAtraso).toFixed(2));

  return { baseValue, multa, juros, diasAtraso, valueComAtraso, taxaCartao, totalCartao };
}

// ── SYNC CUSTOMERS (atualiza mobilePhone no Asaas para todos os inquilinos) ──
async function handleSyncCustomers(db, body) {
  const ownerId = body?.ownerId || await getDefaultOwnerId(db);
  const apiKey = await getAsaasKey(db, ownerId);
  if (!apiKey) throw Object.assign(new Error('Chave Asaas não configurada'), { status: 500 });
  const usersSnap = await db.collection('users').where('ownerId', '==', ownerId).get();
  const results = { updated: 0, skipped: 0, errors: [] };

  await Promise.all(usersSnap.docs.map(async (doc) => {
    const user = doc.data();
    const phone = (user.phone || '').replace(/\D/g, '');
    const email = user.email || '';
    if (!email || phone.length < 10) { results.skipped++; return; }

    try {
      const search = await fetch(
        `https://api.asaas.com/v3/customers?email=${encodeURIComponent(email)}&limit=1`,
        { headers: { 'access_token': apiKey } }
      );
      const { data } = await search.json();
      if (!data?.length) { results.skipped++; return; }

      const existing = data[0];
      if (existing.mobilePhone) { results.skipped++; return; } // já tem

      await fetch(`https://api.asaas.com/v3/customers/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
        body: JSON.stringify({ name: existing.name, mobilePhone: phone })
      });
      results.updated++;
    } catch (e) {
      results.errors.push(`${email}: ${e.message}`);
    }
  }));

  return { ok: true, ...results };
}

// ── TERMS CHECK ──────────────────────────────────────────────────────────────
const CURRENT_TERMS_VERSION = '2025-01';

async function handleCheckTerms(db, body) {
  const { tenantId } = body;
  if (!tenantId) throw Object.assign(new Error('tenantId obrigatório'), { status: 400 });
  const snap = await db.collection('users').doc(tenantId).get();
  const data = snap.exists ? snap.data() : {};
  const alreadyAccepted = data.acceptedTermsVersion === CURRENT_TERMS_VERSION;
  // Auto-aceita se ainda não aceitou (compatibilidade com versões antigas do app)
  if (!alreadyAccepted && snap.exists) {
    await db.collection('users').doc(tenantId).set({
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      termsAcceptedAt: new Date()
    }, { merge: true });
  }
  return {
    accepted:        true,
    currentVersion:  CURRENT_TERMS_VERSION,
    acceptedVersion: CURRENT_TERMS_VERSION,
    acceptedAt:      data.termsAcceptedAt?.toDate?.()?.toISOString() || new Date().toISOString()
  };
}

// ── TERMS ACCEPT (grava aceite + log de auditoria LGPD) ──────────────────────
async function handleAcceptTerms(db, body, req) {
  const { tenantId, email } = body;
  if (!tenantId) throw Object.assign(new Error('tenantId obrigatório'), { status: 400 });

  const now = new Date();
  const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const ua  = req.headers['user-agent'] || 'unknown';

  await db.collection('users').doc(tenantId).set({
    termsAcceptedAt:      now,
    acceptedTermsVersion: CURRENT_TERMS_VERSION,
    ...(email ? { email: email.toLowerCase() } : {})
  }, { merge: true });

  await db.collection('termsAuditLog').add({
    uid:          tenantId,
    email:        email || '',
    termsVersion: CURRENT_TERMS_VERSION,
    ipAddress:    ip,
    userAgent:    ua,
    timestampUtc: now,
    platform:     req.headers['x-platform'] || 'android'
  });

  return { ok: true, version: CURRENT_TERMS_VERSION };
}

// ── SYNC STATUS ──────────────────────────────────────────────────────────────
async function handleSyncStatus(db, body) {
  const ownerId = body?.ownerId || await getDefaultOwnerId(db);
  const apiKey = await getAsaasKey(db, ownerId);
  if (!apiKey) throw Object.assign(new Error('Chave Asaas não configurada'), { status: 500 });

  // Cobranças pagas → verifica estorno no Asaas
  const paidSnap = await db.collection('charges')
    .where('ownerId', '==', ownerId)
    .where('status', '==', 'paid')
    .get();

  const toReset = [];
  await Promise.all(paidSnap.docs.map(async (doc) => {
    const data = doc.data();
    if (!data.asaasChargeId) return;
    try {
      const payment = await asaasReq('GET', `/payments/${data.asaasChargeId}`, null, apiKey);
      if (['REFUNDED', 'CHARGEBACK', 'REFUND_REQUESTED'].includes(payment.status)) {
        await doc.ref.update({
          status:        'pending',
          asaasChargeId: '',
          pixCopyPaste:  '',
          pixQrCode:     '',
          paidAt:        null,
          refundedAt:    new Date(),
          refundNote:    `sincronizado do Asaas: ${payment.status}`
        });
        toReset.push(doc.id);
      }
    } catch (_) {}
  }));

  // Cobranças pendentes/vencidas com asaasChargeId → verifica se foram pagas no Asaas
  const pendingSnap = await db.collection('charges')
    .where('ownerId', '==', ownerId)
    .where('status', 'in', ['pending', 'overdue'])
    .get();

  const newlyPaid = [];
  await Promise.all(pendingSnap.docs.map(async (doc) => {
    const data = doc.data();
    if (!data.asaasChargeId) return;
    try {
      const payment = await asaasReq('GET', `/payments/${data.asaasChargeId}`, null, apiKey);
      if (['CONFIRMED', 'RECEIVED'].includes(payment.status)) {
        await doc.ref.update({ status: 'paid', paidAt: new Date() });
        newlyPaid.push({ chargeId: doc.id, contractId: data.contractId, ownerId });
      }
    } catch (_) {}
  }));

  // Para cada pagamento confirmado: gera próxima cobrança + notifica tenant por push
  if (newlyPaid.length > 0) {
    await handleGenerateCharges(db, { ownerId, monthOffset: 1 }).catch(() => {});

    // Push de confirmação para cada tenant que pagou
    await Promise.all(newlyPaid.map(async ({ chargeId }) => {
      try {
        const chargeSnap = await db.collection('charges').doc(chargeId).get();
        if (!chargeSnap.exists) return;
        const tenantId = chargeSnap.data().tenantId;
        if (!tenantId) return;
        const userSnap = await db.collection('users').doc(tenantId).get();
        const token = userSnap.data()?.fcmToken;
        if (!token) return;
        await getMessaging().send({
          token,
          notification: { title: '✅ Pagamento confirmado!', body: 'Seu aluguel foi recebido. Obrigado!' },
          android: { priority: 'high' }
        });
      } catch (_) {}
    }));
  }

  return { ok: true, reset: toReset.length, confirmed: newlyPaid.length };
}

// ── GENERATE CHARGES ─────────────────────────────────────────────────────────
// Para cada contrato ativo do owner, verifica se já existe cobrança do mês
// corrente (ou próximo). Se não, cria automaticamente.
async function handleGenerateCharges(db, body) {
  const { ownerId, monthOffset = 0 } = body;
  // monthOffset=0 → mês atual, 1 → próximo mês
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const contractsSnap = await db.collection('contracts')
    .where('ownerId', '==', ownerId)
    .where('active', '==', true)
    .get();

  if (contractsSnap.empty) return { ok: true, created: 0 };

  const now      = new Date();
  const target   = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year     = target.getFullYear();
  const month    = target.getMonth(); // 0-indexed

  let created = 0;
  const newCharges = [];
  const batch = db.batch();

  await Promise.all(contractsSnap.docs.map(async contractDoc => {
    const contract = contractDoc.data();
    const { tenantId, tenantEmail, baseRent, dueDay = 10, id: contractId } = contract;
    if (!tenantId || !baseRent) return;

    // dueDate = ano/mês alvo + dia de vencimento
    let dueDate = new Date(year, month, dueDay);
    // se o dia não existe no mês (ex: 31 de fevereiro), JS avança para o próximo mês — corrigir
    if (dueDate.getMonth() !== month) {
      dueDate = new Date(year, month + 1, 0); // último dia do mês
    }

    const dueSecs = Math.floor(dueDate.getTime() / 1000);
    const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;

    // Verifica se já existe cobrança para este contrato neste mês
    const existing = await db.collection('charges')
      .where('contractId', '==', contractId)
      .where('monthRef', '==', monthStr)
      .limit(1)
      .get();

    if (!existing.empty) return; // já existe

    const chargeRef = db.collection('charges').doc();
    batch.set(chargeRef, {
      id:           chargeRef.id,
      contractId,
      tenantId,
      tenantEmail:  tenantEmail || '',
      dueDate:      { seconds: dueSecs, nanoseconds: 0 },
      baseRent,
      extras:       [],
      totalAmount:  baseRent,
      status:       'pending',
      asaasChargeId:'',
      pixCopyPaste: '',
      pixQrCode:    '',
      ownerId,
      monthRef:     monthStr,
      generatedAt:  new Date()
    });
    newCharges.push({ tenantEmail: tenantEmail || '', baseRent, dueDate, monthStr });
    created++;
  }));

  if (created > 0) {
    await batch.commit();
    // Notifica inquilinos por e-mail sobre a nova cobrança (fire-and-forget)
    const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const transporter = nodemailer.createTransport({
      host: 'smtp.titan.email', port: 587, secure: false,
      auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
    });
    await Promise.all(newCharges.map(async ({ tenantEmail, baseRent, dueDate, monthStr }) => {
      if (!tenantEmail) return;
      const dueFmt = dueDate.toLocaleDateString('pt-BR');
      try {
        await transporter.sendMail({
          from:    'LocarPay <denis@dlftech.com.br>',
          to:      tenantEmail,
          subject: `Nova cobrança de aluguel — ${fmt.format(baseRent)}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
              <div style="margin-bottom:24px">
                <span style="background:#1B5E20;color:#fff;font-weight:800;font-size:18px;padding:6px 14px;border-radius:8px">LocarPay</span>
              </div>
              <h2 style="color:#1a1a1a;margin-bottom:8px">Nova cobrança gerada</h2>
              <p style="color:#555;line-height:1.7;margin-bottom:20px">
                Uma nova cobrança de aluguel foi gerada para o mês de <strong>${monthStr}</strong>.
              </p>
              <div style="background:#f5f5f5;border-radius:10px;padding:20px;margin-bottom:24px">
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#777">Valor</span>
                  <span style="font-weight:700;color:#1a1a1a">${fmt.format(baseRent)}</span>
                </div>
                <div style="display:flex;justify-content:space-between">
                  <span style="color:#777">Vencimento</span>
                  <span style="font-weight:700;color:#c62828">${dueFmt}</span>
                </div>
              </div>
              <p style="color:#555;line-height:1.7;margin-bottom:20px">
                Abra o app <strong>LocarPay</strong> para pagar via PIX ou cartão de crédito com apenas alguns toques.
              </p>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
              <p style="color:#aaa;font-size:12px">Pagamento antecipado evita multas e juros por atraso.</p>
            </div>
          `
        });
      } catch (_) {} // falha de e-mail não bloqueia a geração
    }));
  }

  return { ok: true, created };
}

// ── MARK OVERDUE ─────────────────────────────────────────────────────────────
// Marca como 'overdue' cobranças pendentes com vencimento no passado
async function handleMarkOverdue(db, body) {
  const { ownerId } = body;
  const nowSecs = Math.floor(Date.now() / 1000);

  let q = db.collection('charges').where('status', '==', 'pending');
  if (ownerId) q = q.where('ownerId', '==', ownerId);

  const snap = await q.get();
  const overdue = snap.docs.filter(d => {
    const due = d.data().dueDate;
    const dueSecs = due?.seconds ?? due?._seconds ?? 0;
    return dueSecs > 0 && dueSecs < nowSecs;
  });

  if (overdue.length === 0) return { ok: true, updated: 0 };

  const nowMs = Date.now();
  const batch = db.batch();

  overdue.forEach(d => {
    const data   = d.data();
    const dueSecs = data.dueDate?.seconds ?? data.dueDate?._seconds ?? 0;
    const dueDateMs = dueSecs * 1000;
    const diasAtraso = Math.max(1, Math.floor((nowMs - dueDateMs) / 86400000));

    // Aplica multa 2% (uma única vez) e juros 0.033%/dia
    const baseRent = data.baseRent || data.totalAmount || 0;
    const multaJaAplicada = (data.multaAplicada || 0) > 0;
    const multa  = multaJaAplicada ? (data.multaAplicada || 0) : baseRent * 0.02;
    const juros  = baseRent * 0.00033 * diasAtraso;

    const extrasTotal = (data.extras || []).reduce((s, e) => s + (e.value || 0), 0);
    const totalAmount = baseRent + extrasTotal + multa + juros;

    batch.update(d.ref, {
      status:         'overdue',
      multaAplicada:  multa,
      jurosAplicado:  juros,
      diasAtraso,
      totalAmount:    Math.round(totalAmount * 100) / 100
    });
  });

  await batch.commit();
  return { ok: true, updated: overdue.length };
}

// ── SEND PUSH ─────────────────────────────────────────────────────────────────
// Envia notificação FCM para um ou todos os inquilinos com cobranças pendentes/vencidas
async function handleSendPush(db, body) {
  const { tenantId, ownerId, title, message, topic } = body;

  // Notificação para um inquilino específico
  if (tenantId) {
    const userSnap = await db.collection('users').doc(tenantId).get();
    if (!userSnap.exists) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    const token = userSnap.data().fcmToken;
    if (!token) return { ok: true, sent: 0, reason: 'sem_fcm_token' };

    const pendingSnap = await db.collection('charges')
      .where('tenantId', '==', tenantId)
      .where('status', 'in', ['pending', 'overdue'])
      .orderBy('dueDate', 'asc')
      .limit(1)
      .get();
    const chargeId = pendingSnap.docs[0]?.id ?? '';

    await getMessaging().send({
      token,
      notification: { title: title || 'LocarPay', body: message || 'Você tem uma cobrança pendente.' },
      data: chargeId ? { chargeId } : {},
      android: { priority: 'high' }
    });
    return { ok: true, sent: 1 };
  }

  // Notificação em massa: todos inquilinos do owner com cobrança pendente/vencida
  if (!ownerId) throw Object.assign(new Error('tenantId ou ownerId obrigatório'), { status: 400 });

  const chargesSnap = await db.collection('charges')
    .where('ownerId', '==', ownerId)
    .where('status', 'in', ['pending', 'overdue'])
    .get();

  const tenantIds = [...new Set(chargesSnap.docs.map(d => d.data().tenantId).filter(Boolean))];
  if (tenantIds.length === 0) return { ok: true, sent: 0 };

  // Busca tokens em lotes de 10 (limite Firestore whereIn)
  const tokens = [];
  for (let i = 0; i < tenantIds.length; i += 10) {
    const batch = tenantIds.slice(i, i + 10);
    const usersSnap = await db.collection('users').where('__name__', 'in', batch).get();
    usersSnap.docs.forEach(d => {
      const t = d.data().fcmToken;
      if (t) tokens.push(t);
    });
  }

  if (tokens.length === 0) return { ok: true, sent: 0, reason: 'sem_tokens' };

  const defaultTitle = title || 'LocarPay — Cobrança pendente';
  const defaultBody  = message || 'Você tem uma cobrança de aluguel aguardando pagamento. Acesse o app para pagar.';

  // Envia em lotes de 500 (limite FCM multicast)
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const resp = await getMessaging().sendEachForMulticast({
      tokens: chunk,
      notification: { title: defaultTitle, body: defaultBody },
      android: { priority: 'high' }
    });
    sent += resp.successCount;
  }
  return { ok: true, sent, total: tokens.length };
}

// ── NOTIFY UPCOMING ──────────────────────────────────────────────────────────
// Envia push para inquilinos com cobrança vencendo nos próximos N dias
async function handleNotifyUpcoming(db, body) {
  const { ownerId, daysAhead = 3 } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const nowSecs   = Math.floor(Date.now() / 1000);
  const limitSecs = nowSecs + daysAhead * 86400;

  const snap = await db.collection('charges')
    .where('ownerId', '==', ownerId)
    .where('status', '==', 'pending')
    .get();

  // Filtra cobranças que vencem dentro de daysAhead dias E que não foram notificadas hoje
  const todayStr = new Date().toISOString().slice(0, 10);
  const upcoming = snap.docs.filter(d => {
    const due = d.data().dueDate;
    const dueSecs = due?.seconds ?? due?._seconds ?? 0;
    const lastNotif = d.data().upcomingNotifiedDate;
    return dueSecs >= nowSecs && dueSecs <= limitSecs && lastNotif !== todayStr;
  });

  if (upcoming.length === 0) return { ok: true, sent: 0, reason: 'nenhuma_próxima' };

  // Agrupa por tenantId para evitar duplicatas
  const byTenant = {};
  upcoming.forEach(d => {
    const { tenantId, dueDate, totalAmount, baseRent } = d.data();
    if (!byTenant[tenantId]) byTenant[tenantId] = { chargeIds: [], dueDate, amount: totalAmount || baseRent || 0 };
    byTenant[tenantId].chargeIds.push(d.id);
  });

  const tenantIds = Object.keys(byTenant);
  const tokens = [];
  for (let i = 0; i < tenantIds.length; i += 10) {
    const slice = tenantIds.slice(i, i + 10);
    const usersSnap = await db.collection('users').where('__name__', 'in', slice).get();
    usersSnap.docs.forEach(d => {
      const token = d.data().fcmToken;
      if (token) tokens.push({ token, tenantId: d.id });
    });
  }

  if (tokens.length === 0) return { ok: true, sent: 0, reason: 'sem_tokens' };

  const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  let sent = 0;

  await Promise.all(tokens.map(async ({ token, tenantId }) => {
    const info = byTenant[tenantId];
    const dueD = info.dueDate?.seconds ? new Date(info.dueDate.seconds * 1000) : null;
    const diff  = dueD ? Math.ceil((dueD - Date.now()) / 86400000) : daysAhead;
    const dateStr = dueD ? dueD.toLocaleDateString('pt-BR') : '';
    try {
      await getMessaging().send({
        token,
        notification: {
          title: `Vencimento em ${diff} dia${diff !== 1 ? 's' : ''}`,
          body: `Sua cobrança de ${fmt.format(info.amount)} vence em ${dateStr}. Pague agora pelo app.`
        },
        data: info.chargeIds[0] ? { chargeId: info.chargeIds[0] } : {},
        android: { priority: 'high' }
      });
      // Marca cobranças como notificadas hoje
      const batch = db.batch();
      info.chargeIds.forEach(id => batch.update(db.collection('charges').doc(id), { upcomingNotifiedDate: todayStr }));
      await batch.commit();
      sent++;
    } catch (_) {}
  }));

  return { ok: true, sent, total: tenantIds.length };
}

// ── SEND RECEIPT ─────────────────────────────────────────────────────────────
async function handleSendReceipt(db, body) {
  const { chargeId, tenantId } = body;
  if (!chargeId || !tenantId) throw Object.assign(new Error('chargeId e tenantId obrigatórios'), { status: 400 });

  const [chargeSnap, userSnap] = await Promise.all([
    db.collection('charges').doc(chargeId).get(),
    db.collection('users').doc(tenantId).get()
  ]);
  if (!chargeSnap.exists) throw Object.assign(new Error('Cobrança não encontrada'), { status: 404 });
  if (!userSnap.exists)  throw Object.assign(new Error('Usuário não encontrado'),  { status: 404 });

  const charge = chargeSnap.data();
  const user   = userSnap.data();
  if (!user.email) throw Object.assign(new Error('Inquilino sem e-mail cadastrado'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(charge.ownerId).get();
  const ownerName = ownerSnap.exists ? (ownerSnap.data().name || 'Imobiliária') : 'Imobiliária';

  const fmt     = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtDate = secs => secs ? new Date(secs * 1000).toLocaleDateString('pt-BR') : '—';
  const total   = charge.totalAmount || charge.baseRent || 0;
  const paidAt  = charge.paidAt?.seconds ? fmtDate(charge.paidAt.seconds) : new Date().toLocaleDateString('pt-BR');
  const dueDate = fmtDate(charge.dueDate?.seconds);
  const monthRef = charge.monthRef || dueDate.slice(3); // MM/AAAA fallback

  const extrasRows = (charge.extras || []).map(e =>
    `<tr><td style="padding:6px 0;color:#555;border-bottom:1px solid #eee">${e.description}</td>
     <td style="padding:6px 0;text-align:right;border-bottom:1px solid #eee">${fmt.format(e.value)}</td></tr>`
  ).join('');

  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });

  await transporter.sendMail({
    from: `LocarPay — ${ownerName} <denis@dlftech.com.br>`,
    to: user.email,
    subject: `Recibo de pagamento — ${monthRef}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fafafa">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
          <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
          <span style="font-size:18px;font-weight:700;color:#1a1a1a">LocarPay</span>
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e8e8e8">
          <div style="text-align:center;margin-bottom:24px">
            <div style="font-size:40px;margin-bottom:8px">✅</div>
            <h2 style="color:#1a1a1a;margin:0 0 4px">Pagamento confirmado</h2>
            <p style="color:#888;margin:0;font-size:14px">Referência: ${monthRef}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Inquilino</td>
                <td style="padding:8px 0;text-align:right;font-weight:600;border-bottom:1px solid #eee">${user.name || user.email}</td></tr>
            <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Imóvel</td>
                <td style="padding:8px 0;text-align:right;border-bottom:1px solid #eee">${charge.propertyDescription || '—'}</td></tr>
            <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Vencimento</td>
                <td style="padding:8px 0;text-align:right;border-bottom:1px solid #eee">${dueDate}</td></tr>
            <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Aluguel base</td>
                <td style="padding:8px 0;text-align:right;border-bottom:1px solid #eee">${fmt.format(charge.baseRent || 0)}</td></tr>
            ${extrasRows}
            <tr><td style="padding:12px 0;font-weight:700;font-size:16px">Total pago</td>
                <td style="padding:12px 0;text-align:right;font-weight:800;font-size:18px;color:#2D6A2D">${fmt.format(total)}</td></tr>
          </table>
          <p style="color:#888;font-size:12px;text-align:center;margin:0">Pago em ${paidAt} • Gerado por LocarPay</p>
        </div>
        <p style="color:#aaa;font-size:11px;text-align:center;margin-top:20px">Este é um comprovante automático. Em caso de dúvidas, entre em contato com ${ownerName}.</p>
      </div>`
  });

  await chargeSnap.ref.update({ receiptSentAt: new Date() });
  return { ok: true, sentTo: user.email };
}

// ── CLOSE CONTRACT ────────────────────────────────────────────────────────────
async function handleCloseContract(db, body) {
  const { contractId, tenantId, ownerId, cancelPendingCharges = true } = body;
  if (!contractId || !tenantId) throw Object.assign(new Error('contractId e tenantId obrigatórios'), { status: 400 });

  const batch = db.batch();

  // Desativa contrato
  batch.update(db.collection('contracts').doc(contractId), {
    active: false, closedAt: new Date(), closedReason: body.reason || 'encerrado pelo administrador'
  });

  // Cancela cobranças futuras (pending/overdue sem pagamento)
  if (cancelPendingCharges) {
    const pendingSnap = await db.collection('charges')
      .where('contractId', '==', contractId)
      .where('status', 'in', ['pending', 'overdue'])
      .get();
    pendingSnap.docs.forEach(d => batch.update(d.ref, { status: 'cancelled', cancelledAt: new Date() }));
  }

  await batch.commit();
  return { ok: true, contractId, pendingCancelled: cancelPendingCharges };
}

// ── ADJUST RENT ──────────────────────────────────────────────────────────────
// Aplica reajuste percentual em todos os contratos ativos do owner (ou um específico)
async function handleAdjustRent(db, body) {
  const { ownerId, contractId, percentage } = body;
  if (!ownerId || percentage == null) throw Object.assign(new Error('ownerId e percentage obrigatórios'), { status: 400 });
  if (percentage <= -100 || percentage > 100) throw Object.assign(new Error('percentage deve estar entre -100 e 100'), { status: 400 });

  const factor = 1 + percentage / 100;
  let q = db.collection('contracts').where('ownerId', '==', ownerId).where('active', '==', true);
  if (contractId) q = db.collection('contracts').doc(contractId);

  const snap = contractId
    ? await db.collection('contracts').doc(contractId).get().then(d => ({ docs: d.exists ? [d] : [] }))
    : await q.get();

  if (snap.docs.length === 0) return { ok: true, updated: 0 };

  const batch = db.batch();
  const updates = [];

  for (const d of snap.docs) {
    const data = d.data();
    if (data.ownerId !== ownerId) continue; // sanidade
    const newRent = Math.round(data.baseRent * factor * 100) / 100;
    batch.update(d.ref, {
      baseRent:        newRent,
      lastAdjustment:  { percentage, appliedAt: new Date(), oldRent: data.baseRent }
    });
    updates.push({ contractId: d.id, oldRent: data.baseRent, newRent });
  }

  await batch.commit();
  return { ok: true, updated: updates.length, contracts: updates };
}

// ── MONTHLY REPORT ───────────────────────────────────────────────────────────
// Envia ao owner um email com resumo do mês: quem pagou, quem deve, total recebido
async function handleMonthlyReport(db, body) {
  const { ownerId, monthRef } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  const owner = ownerSnap.data();
  if (!owner.email) throw Object.assign(new Error('Owner sem email'), { status: 400 });

  // Determina mês de referência (padrão: mês atual)
  const now    = new Date();
  const target = monthRef || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const snap = await db.collection('charges')
    .where('ownerId', '==', ownerId)
    .where('monthRef', '==', target)
    .get();

  if (snap.empty) return { ok: true, skipped: true, reason: 'sem_cobranças_no_mês' };

  const charges   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const paid      = charges.filter(c => c.status === 'paid');
  const pending   = charges.filter(c => c.status === 'pending');
  const overdue   = charges.filter(c => c.status === 'overdue');
  const totalPaid = paid.reduce((s, c) => s + (c.totalAmount || 0), 0);
  const totalDue  = [...pending, ...overdue].reduce((s, c) => s + (c.totalAmount || 0), 0);

  // Busca nomes dos inquilinos
  const tenantIds = [...new Set(charges.map(c => c.tenantId).filter(Boolean))];
  const nameMap = {};
  for (let i = 0; i < tenantIds.length; i += 10) {
    const slice = tenantIds.slice(i, i + 10);
    const usersSnap = await db.collection('users').where('__name__', 'in', slice).get();
    usersSnap.docs.forEach(d => { nameMap[d.id] = d.data().name || d.data().email || d.id; });
  }

  const fmt = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const [year, month] = target.split('-');
  const monthName = new Date(+year, +month - 1, 1)
    .toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

  const paidRows = paid.map(c =>
    `<tr><td style="padding:6px 12px">${nameMap[c.tenantId] || c.tenantId}</td>
     <td style="padding:6px 12px;text-align:right;color:#2D6A2D;font-weight:600">${fmt(c.totalAmount || 0)}</td>
     <td style="padding:6px 12px;color:#4CAF50">✅ Pago</td></tr>`).join('');

  const overdueRows = overdue.map(c =>
    `<tr><td style="padding:6px 12px">${nameMap[c.tenantId] || c.tenantId}</td>
     <td style="padding:6px 12px;text-align:right;color:#c62828;font-weight:600">${fmt(c.totalAmount || 0)}</td>
     <td style="padding:6px 12px;color:#ef5350">⚠️ Vencida</td></tr>`).join('');

  const pendingRows = pending.map(c =>
    `<tr><td style="padding:6px 12px">${nameMap[c.tenantId] || c.tenantId}</td>
     <td style="padding:6px 12px;text-align:right;color:#e65100;font-weight:600">${fmt(c.totalAmount || 0)}</td>
     <td style="padding:6px 12px;color:#FFB74D">🕐 Pendente</td></tr>`).join('');

  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });

  await transporter.sendMail({
    from: 'LocarPay <denis@dlftech.com.br>',
    to: owner.email,
    subject: `Relatório de ${monthName} — LocarPay`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fafafa">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
          <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
          <span style="font-size:18px;font-weight:700;color:#1a1a1a">LocarPay</span>
        </div>
        <h2 style="color:#1a1a1a;margin-bottom:4px">Relatório de ${monthName}</h2>
        <p style="color:#888;margin-bottom:24px">${owner.name || owner.companyName || 'Proprietário'}</p>

        <!-- KPIs -->
        <div style="display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap">
          <div style="flex:1;min-width:130px;background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:16px;text-align:center">
            <div style="font-size:11px;color:#888;margin-bottom:4px">TOTAL RECEBIDO</div>
            <div style="font-size:22px;font-weight:800;color:#2D6A2D">${fmt(totalPaid)}</div>
            <div style="font-size:12px;color:#aaa">${paid.length} pagamento${paid.length !== 1 ? 's' : ''}</div>
          </div>
          <div style="flex:1;min-width:130px;background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:16px;text-align:center">
            <div style="font-size:11px;color:#888;margin-bottom:4px">A RECEBER</div>
            <div style="font-size:22px;font-weight:800;color:#e65100">${fmt(totalDue)}</div>
            <div style="font-size:12px;color:#aaa">${pending.length + overdue.length} em aberto</div>
          </div>
          <div style="flex:1;min-width:130px;background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:16px;text-align:center">
            <div style="font-size:11px;color:#888;margin-bottom:4px">TAXA DE RECEBIMENTO</div>
            <div style="font-size:22px;font-weight:800;color:#1a1a1a">${charges.length > 0 ? Math.round(paid.length / charges.length * 100) : 0}%</div>
            <div style="font-size:12px;color:#aaa">${paid.length}/${charges.length} contratos</div>
          </div>
        </div>

        <!-- Tabela de cobranças -->
        <div style="background:#fff;border:1px solid #e8e8e8;border-radius:12px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
              <tr style="background:#f5f5f5">
                <th style="padding:10px 12px;text-align:left;font-weight:600;color:#555">Inquilino</th>
                <th style="padding:10px 12px;text-align:right;font-weight:600;color:#555">Valor</th>
                <th style="padding:10px 12px;font-weight:600;color:#555">Status</th>
              </tr>
            </thead>
            <tbody>
              ${paidRows}${overdueRows}${pendingRows}
            </tbody>
          </table>
        </div>

        <p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px">
          Relatório gerado automaticamente pelo LocarPay — ${new Date().toLocaleDateString('pt-BR')}
        </p>
      </div>`
  });

  await ownerSnap.ref.update({ lastReportSentAt: new Date(), lastReportMonth: target });
  return { ok: true, sentTo: owner.email, month: target, paid: paid.length, pending: pending.length + overdue.length, totalPaid };
}

// ── ASAAS PAYMENT WEBHOOK ────────────────────────────────────────────────────
// Recebe eventos PAYMENT_RECEIVED / PAYMENT_CONFIRMED das subcontas dos owners
// O Asaas envia para /api/locarpay-card com o corpo do evento
async function handleAsaasPaymentWebhook(db, body) {
  const { event, payment } = body || {};
  if (!event || !payment) return { ok: true, ignored: true };

  const asaasId = payment.id;
  if (!asaasId) return { ok: true, ignored: true };

  if (!['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) {
    return { ok: true, ignored: true, event };
  }

  // Localiza a cobrança pelo asaasChargeId
  const snap = await db.collection('charges')
    .where('asaasChargeId', '==', asaasId)
    .limit(1)
    .get();

  if (snap.empty) return { ok: true, notFound: true, asaasId };

  const chargeDoc = snap.docs[0];
  const charge    = chargeDoc.data();

  // Já marcada como paga — idempotência
  if (charge.status === 'paid') return { ok: true, alreadyPaid: true };

  // Marca como paga
  await chargeDoc.ref.update({ status: 'paid', paidAt: new Date() });

  // Push de confirmação ao tenant
  try {
    const tenantId = charge.tenantId;
    if (tenantId) {
      const userSnap = await db.collection('users').doc(tenantId).get();
      const token = userSnap.data()?.fcmToken;
      if (token) {
        await getMessaging().send({
          token,
          notification: { title: '✅ Pagamento confirmado!', body: 'Seu aluguel foi recebido. Obrigado!' },
          android: { priority: 'high' }
        });
      }
    }
  } catch (_) {}

  // Gera próxima cobrança do mês seguinte
  const ownerId = charge.ownerId;
  if (ownerId) {
    await handleGenerateCharges(db, { ownerId, monthOffset: 1 }).catch(() => {});
  }

  return { ok: true, event, chargeId: chargeDoc.id, action: 'marked_paid' };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();

    const { step, ownerId: bodyOwnerId } = req.body || {};

    // Verifica plano ativo nos steps que geram cobranças
    if (step === 'init' || step === 'confirm' || step === 'preview') {
      const checkId = bodyOwnerId || await getDefaultOwnerId(db).catch(() => null);
      if (checkId) {
        const plan = await checkOwnerPlanActive(db, checkId);
        if (!plan.active) {
          return res.status(402).json({
            error: 'Plano expirado. Acesse o painel LocarPay para renovar a assinatura.',
            reason: plan.reason
          });
        }
      }
    }

    if (step === 'init')           return res.status(200).json(await handleInit(db, req.body, null));
    if (step === 'confirm')        return res.status(200).json(await handleConfirm(db, req.body));
    if (step === 'refund')         return res.status(200).json(await handleRefund(db, req.body));
    if (step === 'preview')        return res.status(200).json(await handlePreview(db, req.body));
    if (step === 'list-saved')     return res.status(200).json(await handleListSaved(db, req.body));
    if (step === 'delete-saved')   return res.status(200).json(await handleDeleteSaved(db, req.body));
    if (step === 'sync-status')    return res.status(200).json(await handleSyncStatus(db, req.body));
    if (step === 'sync-customers') return res.status(200).json(await handleSyncCustomers(db, req.body));
    if (step === 'check-terms')    return res.status(200).json(await handleCheckTerms(db, req.body));
    if (step === 'accept-terms')   return res.status(200).json(await handleAcceptTerms(db, req.body, req));
    if (step === 'mark-overdue')      return res.status(200).json(await handleMarkOverdue(db, req.body));
    if (step === 'send-push')         return res.status(200).json(await handleSendPush(db, req.body));
    if (step === 'generate-charges')  return res.status(200).json(await handleGenerateCharges(db, req.body));
    if (step === 'notify-upcoming')   return res.status(200).json(await handleNotifyUpcoming(db, req.body));
    if (step === 'send-receipt')      return res.status(200).json(await handleSendReceipt(db, req.body));
    if (step === 'close-contract')    return res.status(200).json(await handleCloseContract(db, req.body));
    if (step === 'adjust-rent')       return res.status(200).json(await handleAdjustRent(db, req.body));
    if (step === 'monthly-report')    return res.status(200).json(await handleMonthlyReport(db, req.body));
    if (step === 'asaas-webhook')     return res.status(200).json(await handleAsaasPaymentWebhook(db, req.body));

    // Webhook Asaas sem step (evento direto da subconta)
    if (!step && req.body?.event && req.body?.payment) {
      return res.status(200).json(await handleAsaasPaymentWebhook(db, req.body));
    }

    return res.status(400).json({ error: 'step inválido' });

  } catch (e) {
    console.error('locarpay-card error:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
