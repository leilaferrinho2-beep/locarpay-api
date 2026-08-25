// POST /api/locarpay-card
// step:"init"           → { tenantId, chargeId, card }           → micro-cobrança no cartão, retorna { verificationId }
// step:"verify-amount"  → { verificationId, userAmount }         → valida valor visto no banco; estorna micro se correto
// step:"confirm"        → { verificationId, saveCard? }          → cobra aluguel real (exige amountVerified=true)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth }                        from 'firebase-admin/auth';
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

// ── PIX AUTO-CHARGE ──────────────────────────────────────────────────────────
// Cria cobrança PIX no Asaas para uma charge do Firestore e salva QR code.
// ownerCfg: { finePercentage, interestRate } — valores em % ao mês.
async function createPixForCharge(db, chargeId, tenantId, amount, dueDate, apiKey, ownerCfg = {}) {
  const tenantSnap = await db.collection('users').doc(tenantId).get();
  if (!tenantSnap.exists) return;
  const t = tenantSnap.data();
  const customerId = await findOrCreateCustomer(t.name || t.email, t.email, t.cpf || t.document, t.phone, apiKey);

  const dueDateStr = (() => {
    const d = dueDate instanceof Date ? dueDate : new Date(dueDate.seconds * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();

  const fineVal     = ownerCfg.finePercentage  ?? 2;
  const interestVal = ownerCfg.interestRate     ?? 1;

  const pixBody = {
    customer:    customerId,
    billingType: 'PIX',
    value:       parseFloat(amount.toFixed(2)),
    dueDate:     dueDateStr,
    description: 'Aluguel iLocarPay',
    fine:     { value: fineVal },
    interest: { value: interestVal },
  };

  let res;
  try {
    res = await asaasReq('POST', '/payments', pixBody, apiKey);
  } catch (e) {
    console.error('[PIX] createPixForCharge error:', e.message);
    return;
  }

  const pixQrRes = await asaasReq('GET', `/payments/${res.id}/pixQrCode`, null, apiKey).catch(() => null);

  await db.collection('charges').doc(chargeId).update({
    asaasChargeId: res.id,
    pixQrCode:     pixQrRes?.encodedImage  || res.pixQrCode      || '',
    pixCopyPaste:  pixQrRes?.payload       || res.pixCopyPaste   || '',
    pixExpiresAt:  pixQrRes?.expirationDate ? new Date(pixQrRes.expirationDate) : null,
  });
}

// Atualiza QR codes PIX de cobranças em atraso (roda no cron diário).
// Para cada charge pending com pixQrCode e vencida, re-busca QR no Asaas.
async function handleRefreshOverduePixQr(db, { ownerId }) {
  const apiKey = await getAsaasKey(db, ownerId);
  if (!apiKey) return { refreshed: 0 };

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  const ownerCfg  = ownerSnap.exists ? ownerSnap.data() : {};

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todaySecs = Math.floor(today.getTime() / 1000);

  const snap = await db.collection('charges')
    .where('ownerId', '==', ownerId)
    .where('status', '==', 'pending')
    .get();

  let refreshed = 0;
  await Promise.all(snap.docs.map(async doc => {
    const charge = doc.data();
    if (!charge.asaasChargeId) return;
    const dueSecs = charge.dueDate?.seconds ?? 0;
    if (dueSecs >= todaySecs) return; // ainda não venceu

    try {
      const pixQrRes = await asaasReq('GET', `/payments/${charge.asaasChargeId}/pixQrCode`, null, apiKey);
      await doc.ref.update({
        pixQrCode:    pixQrRes.encodedImage  || charge.pixQrCode,
        pixCopyPaste: pixQrRes.payload       || charge.pixCopyPaste,
        pixExpiresAt: pixQrRes.expirationDate ? new Date(pixQrRes.expirationDate) : null,
        pixRefreshedAt: new Date(),
      });
      refreshed++;
    } catch (e) {
      console.warn(`[PIX] refresh ${doc.id}:`, e.message);
    }
  }));

  return { refreshed };
}

// ── INIT ────────────────────────────────────────────────────────────────────
async function handleInit(db, body, apiKey) {
  const { tenantId, chargeId, card, savedCardId } = body;
  if (!tenantId || !chargeId)
    throw Object.assign(new Error('tenantId e chargeId obrigatórios'), { status: 400 });

  let holderName, number, expiryMonth, expiryYear, ccv, holderDocument;
  let usingSavedCard = false;
  let savedCardFallback = null;
  let savedToken = null;

  if (savedCardId) {
    // Usa cartão salvo
    const savedSnap = await db.collection('users').doc(tenantId).collection('savedCards').doc(savedCardId).get();
    if (!savedSnap.exists) throw Object.assign(new Error('Cartão salvo não encontrado'), { status: 404 });
    const sc = savedSnap.data();
    holderName    = sc.holderName;
    expiryMonth   = sc.expiryMonth;
    expiryYear    = sc.expiryYear;
    holderDocument = sc.holderDocument || '';
    savedToken    = sc.cardToken || null;
    savedCardFallback = sc.cardFallback || null;
    usingSavedCard = true;
    if (!savedToken && !savedCardFallback)
      throw Object.assign(new Error('Dados do cartão salvo incompletos'), { status: 400 });
    if (savedCardFallback) {
      number = savedCardFallback.number;
      ccv    = savedCardFallback.ccv;
    }
  } else {
    if (!card) throw Object.assign(new Error('card obrigatório'), { status: 400 });
    ({ holderName, number, expiryMonth, expiryYear, ccv, holderDocument } = card);
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

  // Busca owner doc (para CEP e config de taxas)
  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  const configData = ownerSnap.exists ? ownerSnap.data() : {};

  let postalCode = (user.postalCode || user.cep || '').replace(/\D/g, '');
  if (postalCode.length !== 8) postalCode = (configData.postalCode || '').replace(/\D/g, '');
  if (postalCode.length !== 8) postalCode = '01310100';

  // Calcula valor real do aluguel (com taxa de cartão e eventuais juros/multa)
  const cardFeeRate  = (configData.cardFeePercentage ?? 2.99) / 100;
  const cardFeeFixed = configData.cardFeeFixed ?? 0.49;
  const charge       = chargeSnap.data();
  const baseValue    = charge.totalAmount || charge.baseRent || 5;
  const dueDateObj   = charge.dueDate?.toDate ? charge.dueDate.toDate() : new Date(charge.dueDate?.seconds * 1000);
  const today        = new Date(); today.setHours(0, 0, 0, 0);
  const dueDateOnly  = new Date(dueDateObj); dueDateOnly.setHours(0, 0, 0, 0);
  const diasAtraso   = Math.max(0, Math.floor((today - dueDateOnly) / 86400000));
  const finePercentage       = (configData.finePercentage          ?? 2)    / 100;
  const interestRate         = (configData.interestRate             ?? 1)    / 100 / 30;
  const monetaryCorrectionRate = (configData.monetaryCorrectionRate ?? 0.35) / 100 / 30;
  let valueComAtraso = baseValue;
  if (diasAtraso > 0) {
    const dailyRate = interestRate + monetaryCorrectionRate;
    valueComAtraso = parseFloat((baseValue * (1 + finePercentage + dailyRate * diasAtraso)).toFixed(2));
  }
  const realValue = parseFloat(((valueComAtraso + cardFeeFixed) / (1 - cardFeeRate)).toFixed(2));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = tomorrow.toISOString().slice(0, 10);

  const customerId = await findOrCreateCustomer(name, email, cpf, phone, apiKey);

  // Usa CPF digitado no formulário (titular do cartão); fallback para CPF do perfil
  const effectiveCpf = (holderDocument || '').replace(/\D/g, '') || cpf;

  const holderInfoBase = {
    name:          holderName,
    email,
    cpfCnpj:       effectiveCpf,
    postalCode,
    addressNumber: 'SN',
    phone:         phone || '11999999999'
  };

  // Gera valor aleatório de micro-cobrança para verificação (R$1,00 a R$9,99)
  const microAmount = parseFloat((1 + Math.random() * 8.99).toFixed(2));

  let chargeBody;
  if (savedToken) {
    chargeBody = {
      customer:             customerId,
      billingType:          'CREDIT_CARD',
      value:                microAmount,
      dueDate,
      description:          'Verificação de cartão iLocarPay',
      creditCardToken:      savedToken,
      creditCardHolderInfo: holderInfoBase
    };
  } else {
    chargeBody = {
      customer:             customerId,
      billingType:          'CREDIT_CARD',
      value:                microAmount,
      dueDate,
      description:          'Verificação de cartão iLocarPay',
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

  const microCharge = await asaasReq('POST', '/payments', chargeBody, apiKey);
  const cardToken   = microCharge.creditCard?.creditCardToken || savedToken || null;
  const lastFour    = microCharge.creditCard?.creditCardNumber?.slice(-4) || '';
  const cardBrand   = microCharge.creditCard?.creditCardBrand || '';

  const verRef   = db.collection('cardVerifications').doc();
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
    holderDocument: effectiveCpf,
    expiryMonth:    expMonth,
    expiryYear:     expYear,
    postalCode,
    email,
    phone:          phone || '',
    microAmount,                         // valor de verificação — inquilino deve confirmar este valor
    microPaymentId: microCharge.id,      // estornamos aqui após verificação bem-sucedida
    realValue,                           // valor real do aluguel — cobrado no confirm
    verifyAttempts: 0,
    amountVerified: false,
    verified:       false,
    createdAt:      FieldValue.serverTimestamp(),
    expiresAt:      new Date(Date.now() + 30 * 60 * 1000)
  };

  if (!cardToken) {
    verData.cardFallback = savedCardFallback || {
      holderName,
      number:      number.replace(/\D/g, ''),
      expiryMonth: expMonth,
      expiryYear:  expYear,
      ccv
    };
  }

  await verRef.set(verData);

  return { verificationId: verRef.id, lastFour, cardBrand };
}

// Cancela ou estorna a micro-cobrança — tenta cancel (pending) e depois refund (confirmed)
async function cancelOrRefundMicro(asaasPaymentId, apiKey, value) {
  if (!asaasPaymentId) return; // sem ID, nada a fazer
  let cancelErr, refundErr;
  try {
    await asaasReq('POST', `/payments/${asaasPaymentId}/cancel`, {}, apiKey);
    return; // sucesso no cancel
  } catch (e) { cancelErr = e?.message || String(e); }
  // Se cancel falhou (pagamento já capturado), tenta refund completo
  try {
    const body = value ? { value } : {};
    await asaasReq('POST', `/payments/${asaasPaymentId}/refund`, body, apiKey);
  } catch (e) {
    refundErr = e?.message || String(e);
    console.error(`[micro-refund] cancel="${cancelErr}" refund="${refundErr}" id=${asaasPaymentId}`);
    // não lança — a cobrança principal não deve ser bloqueada por falha de estorno
  }
}

// ── VERIFY AMOUNT ─────────────────────────────────────────────────────────────
// Inquilino informa o valor cobrado no cartão; backend valida e marca pagamento como pago
async function handleVerifyAmount(db, body, req) {
  const { verificationId, userAmount } = body;
  if (!verificationId || userAmount == null)
    throw Object.assign(new Error('verificationId e userAmount obrigatórios'), { status: 400 });

  const verRef  = db.collection('cardVerifications').doc(verificationId);
  const verSnap = await verRef.get();
  if (!verSnap.exists) throw Object.assign(new Error('Verificação não encontrada'), { status: 404 });

  const ver = verSnap.data();

  if (ver.amountVerified)
    return { ok: true, alreadyVerified: true };

  const chargeSnap = await db.collection('charges').doc(ver.chargeId).get();
  const ownerId    = chargeSnap.data()?.ownerId || await getDefaultOwnerId(db);
  const verApiKey  = await getAsaasKey(db, ownerId);

  if (new Date() > ver.expiresAt.toDate()) {
    await cancelOrRefundMicro(ver.microPaymentId, verApiKey, ver.microAmount);
    throw Object.assign(new Error('Verificação expirada. Recadastre o cartão.'), { status: 400 });
  }

  const entered  = parseFloat(String(userAmount).replace(',', '.'));
  const expected = parseFloat(ver.microAmount);
  const match    = Math.abs(entered - expected) <= 0.02;

  if (!match) {
    // Valor errado → estorna a micro-cobrança e bloqueia
    await cancelOrRefundMicro(ver.microPaymentId, verApiKey, ver.microAmount);
    await verRef.update({ verifyAttempts: (ver.verifyAttempts || 0) + 1, blocked: true });
    throw Object.assign(new Error('Valor incorreto. A micro-cobrança foi estornada. Recadastre o cartão.'), { status: 422 });
  }

  // Valor correto → estorna a micro-cobrança e libera para o confirm cobrar o valor real
  await Promise.all([
    cancelOrRefundMicro(ver.microPaymentId, verApiKey, ver.microAmount),
    verRef.update({ verifyAttempts: (ver.verifyAttempts || 0) + 1, amountVerified: true })
  ]);

  return { ok: true, lastFour: ver.lastFour, cardBrand: ver.cardBrand };
}

// ── CONFIRM ──────────────────────────────────────────────────────────────────
// Micro-cobrança já foi verificada e estornada no verify-amount.
// Este step cobra o valor real do aluguel, salva cartão (opcional) e retorna confirmação.
async function handleConfirm(db, body) {
  const { verificationId } = body;
  if (!verificationId)
    throw Object.assign(new Error('verificationId obrigatório'), { status: 400 });

  const verRef  = db.collection('cardVerifications').doc(verificationId);
  const verSnap = await verRef.get();
  if (!verSnap.exists) throw Object.assign(new Error('Verificação não encontrada'), { status: 404 });

  const ver = verSnap.data();

  if (!ver.amountVerified)
    throw Object.assign(new Error('Cartão não verificado.'), { status: 400 });

  if (ver.verified)
    throw Object.assign(new Error('Pagamento já processado.'), { status: 400 });

  const chargeSnap = await db.collection('charges').doc(ver.chargeId).get();
  const ownerId    = chargeSnap.data()?.ownerId || await getDefaultOwnerId(db);
  const apiKey     = await getAsaasKey(db, ownerId);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = tomorrow.toISOString().slice(0, 10);

  const holderInfoBase = {
    name:          ver.holderName,
    email:         ver.email || '',
    cpfCnpj:       ver.holderDocument || '',
    postalCode:    ver.postalCode || '01310100',
    addressNumber: 'SN',
    phone:         ver.phone || '11999999999'
  };

  let realChargeBody;
  if (ver.cardToken) {
    realChargeBody = {
      customer:             ver.customerId,
      billingType:          'CREDIT_CARD',
      value:                ver.realValue,
      dueDate,
      description:          `Aluguel ${dueDate.slice(0, 7)}`,
      creditCardToken:      ver.cardToken,
      creditCardHolderInfo: holderInfoBase
    };
  } else if (ver.cardFallback) {
    realChargeBody = {
      customer:             ver.customerId,
      billingType:          'CREDIT_CARD',
      value:                ver.realValue,
      dueDate,
      description:          `Aluguel ${dueDate.slice(0, 7)}`,
      creditCard: {
        holderName:  ver.holderName,
        number:      ver.cardFallback.number,
        expiryMonth: ver.expiryMonth,
        expiryYear:  ver.expiryYear,
        ccv:         ver.cardFallback.ccv
      },
      creditCardHolderInfo: holderInfoBase
    };
  } else {
    throw Object.assign(new Error('Dados do cartão indisponíveis para cobrança.'), { status: 400 });
  }

  const realCharge = await asaasReq('POST', '/payments', realChargeBody, apiKey);

  const ops = [
    db.collection('charges').doc(ver.chargeId).update({
      asaasChargeId: realCharge.id,
      status:        'paid',
      paidAt:        FieldValue.serverTimestamp()
    }),
    verRef.update({ verified: true, realPaymentId: realCharge.id, paidAt: FieldValue.serverTimestamp(), cardFallback: FieldValue.delete() }),
    db.collection('paymentLogs').add({
      tenantId:       ver.tenantId,
      chargeId:       ver.chargeId,
      asaasChargeId:  realCharge.id,
      holderName:     ver.holderName,
      holderDocument: ver.holderDocument || '',
      cardLastFour:   ver.lastFour,
      cardBrand:      ver.cardBrand,
      amount:         ver.realValue,
      status:         'paid',
      paidAt:         FieldValue.serverTimestamp(),
      userAgent:      '',
      ip:             '',
      termoAceito:    true
    })
  ];

  if (body.saveCard) {
    const savedCardData = {
      holderName:     ver.holderName,
      holderDocument: ver.holderDocument || '',
      lastFour:       ver.lastFour,
      brand:          ver.cardBrand,
      expiryMonth:    ver.expiryMonth,
      expiryYear:     ver.expiryYear,
      createdAt:      FieldValue.serverTimestamp()
    };
    if (ver.cardToken) savedCardData.cardToken = ver.cardToken;
    ops.push(db.collection('users').doc(ver.tenantId).collection('savedCards').add(savedCardData));
  }

  await Promise.all(ops);

  return {
    paid:         true,
    status:       'CONFIRMED',
    message:      'Pagamento aprovado!',
    totalCharged: ver.realValue
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

  // Regenera PIX após estorno
  const ownerSnap = await db.collection('owners').doc(ownerId).get().catch(() => null);
  const ownerCfg  = ownerSnap?.data() || {};
  createPixForCharge(
    db, chargeId, charge.tenantId,
    charge.totalAmount || charge.baseRent || 0,
    charge.dueDate,
    apiKey, ownerCfg
  ).catch(e => console.error('[PIX] refund regen:', e.message));

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
  const finePercentage         = (cfg.finePercentage          ?? 2)    / 100;
  const interestRate           = (cfg.interestRate             ?? 1)    / 100 / 30;
  const monetaryCorrectionRate = (cfg.monetaryCorrectionRate   ?? 0.35) / 100 / 30;

  const baseValue   = charge.totalAmount || charge.baseRent || 5;
  const dueDateObj  = charge.dueDate?.toDate ? charge.dueDate.toDate() : new Date(charge.dueDate?.seconds * 1000);
  const today       = new Date(); today.setHours(0, 0, 0, 0);
  const dueDateOnly = new Date(dueDateObj); dueDateOnly.setHours(0, 0, 0, 0);
  const diasAtraso  = Math.max(0, Math.floor((today - dueDateOnly) / 86400000));

  let valueComAtraso = baseValue;
  let multa = 0, juros = 0, correcao = 0;
  if (diasAtraso > 0) {
    multa   = parseFloat((baseValue * finePercentage).toFixed(2));
    juros   = parseFloat((baseValue * interestRate * diasAtraso).toFixed(2));
    correcao = parseFloat((baseValue * monetaryCorrectionRate * diasAtraso).toFixed(2));
    valueComAtraso = parseFloat((baseValue + multa + juros + correcao).toFixed(2));
  }

  const totalCartao = parseFloat(((valueComAtraso + cardFeeFixed) / (1 - cardFeeRate)).toFixed(2));
  const taxaCartao  = parseFloat((totalCartao - valueComAtraso).toFixed(2));

  return { baseValue, multa, juros, correcao, diasAtraso, valueComAtraso, taxaCartao, totalCartao };
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
  return {
    accepted:        alreadyAccepted,
    currentVersion:  CURRENT_TERMS_VERSION,
    acceptedVersion: data.acceptedTermsVersion || null,
    acceptedAt:      data.termsAcceptedAt?.toDate?.()?.toISOString() || null
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

// ── CHECK CONTRACT STATUS (polling do app do corretor) ───────────────────────
async function handleCheckContractStatus(db, body) {
  const { contractId } = body;
  if (!contractId) return { ok: false, error: 'contractId obrigatório' };

  const contractRef  = db.collection('contracts').doc(contractId);
  const contractSnap = await contractRef.get();
  if (!contractSnap.exists) return { ok: false, error: 'contrato não encontrado' };

  const c = contractSnap.data();
  const assinafyDocId = c.assinafyDocumentId;
  if (!assinafyDocId) return { ok: true, contractStatus: c.contractStatus || null, skipped: 'sem documentId Assinafy' };

  // Consulta status atual diretamente na Assinafy
  const configSnap = await db.collection('config').doc('assinafy').get();
  const apiKey = configSnap.data()?.apiKey;
  if (!apiKey) return { ok: true, contractStatus: c.contractStatus || null, skipped: 'sem apiKey' };

  const r = await fetch(`https://api.assinafy.com.br/v1/documents/${assinafyDocId}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  if (!r.ok) return { ok: true, contractStatus: c.contractStatus || null };

  const doc = await r.json();
  const signers = doc?.data?.assignment?.signers || doc?.data?.assignments?.[0]?.signers || [];

  const ownerSigned  = signers.some(s => s.step === 1 && s.status === 'signed');
  const tenantSigned = signers.some(s => s.step === 2 && s.status === 'signed');
  const allSigned    = ownerSigned && tenantSigned;

  let newStatus = c.contractStatus;
  const updates = {};

  if (allSigned && c.contractStatus !== 'CONTRATO_ASSINADO') {
    newStatus = 'CONTRATO_ASSINADO';
    updates.contractStatus = newStatus;
    updates.bothSigned     = true;
    updates.ownerSigned    = true;
  } else if (ownerSigned && !tenantSigned && c.contractStatus === 'AGUARDANDO_PROPRIETARIO') {
    newStatus = 'AGUARDANDO_INQUILINO';
    updates.contractStatus = newStatus;
    updates.ownerSigned    = true;
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date();
    await contractRef.update(updates);

    // Propaga ao lead vinculado
    const leadSnap = c.leadId
      ? await db.collection('leads').doc(c.leadId).get()
      : (await db.collection('leads').where('contractId', '==', contractId).limit(1).get()).docs[0];
    if (leadSnap?.exists) await leadSnap.ref.update({ contractStatus: newStatus, updatedAt: new Date() });

    console.log(`[check-contract-status] ${contractId} atualizado → ${newStatus}`);
  }

  return { ok: true, contractStatus: newStatus };
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
        // Regenera PIX após reset por estorno detectado no Asaas
        const ownerCfgSnap = await db.collection('owners').doc(ownerId).get().catch(() => null);
        const ownerCfg = ownerCfgSnap?.data() || {};
        createPixForCharge(
          db, doc.id, data.tenantId,
          data.totalAmount || data.baseRent || 0,
          data.dueDate,
          apiKey, ownerCfg
        ).catch(e => console.error('[PIX] sync refund regen:', e.message));
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

    // Push de confirmação + email de recibo para cada tenant que pagou
    await Promise.all(newlyPaid.map(async ({ chargeId }) => {
      try {
        const chargeSnap = await db.collection('charges').doc(chargeId).get();
        if (!chargeSnap.exists) return;
        const tenantId = chargeSnap.data().tenantId;
        if (!tenantId) return;
        const userSnap = await db.collection('users').doc(tenantId).get();
        const token = userSnap.data()?.fcmToken;
        if (token) {
          await getMessaging().send({
            token,
            notification: { title: '✅ Pagamento confirmado!', body: 'Seu aluguel foi recebido. Obrigado!' },
            data: { type: 'paid', chargeId },
            android: { priority: 'high' }
          });
        }
        // Email de recibo (fire-and-forget)
        handleSendReceipt(db, { chargeId, tenantId }).catch(() => {});

        // Push ao proprietário
        const cData = chargeSnap.data();
        const cOwnerId = cData.ownerId;
        if (cOwnerId) {
          try {
            const [ownerSnap, tSnap] = await Promise.all([
              db.collection('owners').doc(cOwnerId).get(),
              db.collection('users').doc(tenantId).get()
            ]);
            const ownerEmail = ownerSnap.data()?.email;
            const tName = tSnap.data()?.name || 'Inquilino';
            if (ownerEmail) {
              const ouSnap = await db.collection('users')
                .where('email', '==', ownerEmail).where('role', '==', 'admin').limit(1).get();
              const oToken = ouSnap.docs[0]?.data()?.fcmToken;
              if (oToken) {
                const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
                await getMessaging().send({
                  token: oToken,
                  notification: { title: '💰 Pagamento recebido!', body: `${tName} pagou ${fmt.format(cData.totalAmount || 0)}` },
                  data: { type: 'admin', chargeId },
                  android: { priority: 'high' }
                });
              }
            }
          } catch (_) {}
        }
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
    const { tenantId, tenantEmail, baseRent, dueDay = 10, id: contractId, propertyDescription = '' } = contract;
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
    // Primeiro tenta por monthRef (cobranças novas); fallback por dueDate para cobranças antigas
    const existingByMonth = await db.collection('charges')
      .where('contractId', '==', contractId)
      .where('monthRef', '==', monthStr)
      .limit(1)
      .get();
    if (!existingByMonth.empty) return; // já existe

    // Fallback: checa cobranças sem monthRef dentro do mês alvo (evita duplicatas de dados antigos)
    const monthStart = Math.floor(new Date(year, month, 1).getTime() / 1000);
    const monthEnd   = Math.floor(new Date(year, month + 1, 0, 23, 59, 59).getTime() / 1000);
    const existingByDate = await db.collection('charges')
      .where('contractId', '==', contractId)
      .where('dueDate', '>=', { seconds: monthStart, nanoseconds: 0 })
      .where('dueDate', '<=', { seconds: monthEnd,   nanoseconds: 0 })
      .limit(1)
      .get();
    if (!existingByDate.empty) {
      // Migra: adiciona monthRef à cobrança existente para evitar checagem futura por data
      const doc = existingByDate.docs[0];
      if (!doc.data().monthRef) await doc.ref.update({ monthRef: monthStr });
      return;
    }

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
      monthRef:            monthStr,
      propertyDescription: propertyDescription || '',
      generatedAt:         new Date()
    });
    newCharges.push({ chargeId: chargeRef.id, tenantId, tenantEmail: tenantEmail || '', baseRent, dueDate, monthStr });
    created++;
  }));

  if (created > 0) {
    await batch.commit();

    // Busca config do owner para fine/interest do PIX
    const ownerSnap2 = await db.collection('owners').doc(ownerId).get().catch(() => null);
    const ownerCfg2  = ownerSnap2?.exists ? ownerSnap2.data() : {};
    const apiKey2    = await getAsaasKey(db, ownerId).catch(() => null);

    // Gera QR code PIX para cada nova cobrança (fire-and-forget)
    if (apiKey2) {
      Promise.all(newCharges.map(({ chargeId, tenantId: tid, baseRent: amt, dueDate: dd }) =>
        createPixForCharge(db, chargeId, tid, amt, dd, apiKey2, ownerCfg2).catch(e =>
          console.error('[PIX] handleGenerateCharges:', e.message)
        )
      ));
    }

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
          from:    'iLocarPay <denis@dlftech.com.br>',
          to:      tenantEmail,
          subject: `Nova cobrança de aluguel — ${fmt.format(baseRent)}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff">
              <div style="background:#1B5E20;padding:20px 28px;border-radius:12px 12px 0 0">
                <span style="color:#fff;font-weight:800;font-size:20px">iiLocarPay</span>
              </div>
              <div style="padding:28px 28px 8px">
                <p style="color:#888;font-size:13px;margin:0 0 6px">NOVA COBRANÇA — ${monthStr.toUpperCase()}</p>
                <h2 style="color:#1a1a1a;margin:0 0 20px;font-size:24px">${fmt.format(baseRent)}</h2>
                <div style="background:#f8f8f8;border-radius:10px;padding:18px 20px;margin-bottom:24px">
                  <table style="width:100%;border-collapse:collapse">
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Referência</td>
                      <td style="font-weight:600;color:#1a1a1a;text-align:right;font-size:14px">${monthStr}</td>
                    </tr>
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Vencimento</td>
                      <td style="font-weight:600;color:#c62828;text-align:right;font-size:14px">${dueFmt}</td>
                    </tr>
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Valor total</td>
                      <td style="font-weight:700;color:#1B5E20;text-align:right;font-size:15px">${fmt.format(baseRent)}</td>
                    </tr>
                  </table>
                </div>
                <div style="text-align:center;margin-bottom:24px">
                  <p style="color:#444;font-size:14px;margin-bottom:12px">Abra o app iiLocarPay para gerar o QR Code PIX e pagar em segundos.</p>
                  <span style="display:inline-block;background:#1B5E20;color:#fff;font-weight:700;font-size:15px;padding:12px 32px;border-radius:8px">Pagar via iiLocarPay</span>
                </div>
                <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
                <p style="color:#bbb;font-size:11px;text-align:center">Pague até ${dueFmt} para evitar multas e juros. Mensagem automática do iiLocarPay.</p>
              </div>
            </div>
          `
        });
      } catch (_) {} // falha de e-mail não bloqueia a geração
    }));
  }

  return { ok: true, created };
}

// ── AUTO-GENERATE UPCOMING CHARGES ───────────────────────────────────────────
// Roda diariamente: para cada contrato ativo, verifica se hoje está dentro de
// `daysBeforeDue` dias do próximo vencimento. Se sim, cria a cobrança se ainda
// não existir. Configurável por owner via campo `daysBeforeDue` (padrão: 5).
async function handleAutoGenerateUpcoming(db, { ownerId, ownerData = {} }) {
  const daysBeforeDue = typeof ownerData.daysBeforeDue === 'number' ? ownerData.daysBeforeDue : 5;

  const contractsSnap = await db.collection('contracts')
    .where('ownerId', '==', ownerId)
    .where('active', '==', true)
    .get();

  if (contractsSnap.empty) return { created: 0 };

  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // meia-noite local

  let created = 0;
  const newCharges = [];
  const batch = db.batch();

  await Promise.all(contractsSnap.docs.map(async contractDoc => {
    const contract = contractDoc.data();
    const { tenantId, tenantEmail, baseRent, dueDay = 10, id: contractId, propertyDescription = '' } = contract;
    if (!tenantId || !baseRent) return;

    // Próximo vencimento: este mês ou próximo, dependendo de onde estamos
    let dYear  = today.getFullYear();
    let dMonth = today.getMonth(); // 0-indexed

    let dueDate = new Date(dYear, dMonth, dueDay);
    // Ajusta meses curtos (ex: 31 de fevereiro → último dia do mês)
    if (dueDate.getMonth() !== dMonth) dueDate = new Date(dYear, dMonth + 1, 0);

    // Se vencimento deste mês já passou, avança para o próximo
    if (dueDate < today) {
      dMonth += 1;
      dueDate = new Date(dYear, dMonth, dueDay);
      if (dueDate.getMonth() !== ((dMonth) % 12)) dueDate = new Date(dYear, dMonth + 1, 0);
    }

    // Só gera se estamos dentro da janela de daysBeforeDue
    const diffDays = Math.ceil((dueDate - today) / 86400000);
    if (diffDays > daysBeforeDue) return;

    const monthStr  = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`;
    const dueSecs   = Math.floor(dueDate.getTime() / 1000);

    // Deduplicação: já existe cobrança para este contrato neste mês?
    const existing = await db.collection('charges')
      .where('contractId', '==', contractId)
      .where('monthRef',   '==', monthStr)
      .limit(1).get();
    if (!existing.empty) return;

    const chargeRef = db.collection('charges').doc();
    batch.set(chargeRef, {
      id:                  chargeRef.id,
      contractId,
      tenantId,
      tenantEmail:         tenantEmail || '',
      dueDate:             { seconds: dueSecs, nanoseconds: 0 },
      baseRent,
      extras:              [],
      totalAmount:         baseRent,
      status:              'pending',
      asaasChargeId:       '',
      pixCopyPaste:        '',
      pixQrCode:           '',
      ownerId,
      monthRef:            monthStr,
      propertyDescription: propertyDescription || '',
      generatedAt:         new Date()
    });
    newCharges.push({ chargeId: chargeRef.id, tenantId, tenantEmail: tenantEmail || '', baseRent, dueDate, monthStr });
    created++;
  }));

  if (created > 0) {
    await batch.commit();

    // Gera QR code PIX para cada nova cobrança (fire-and-forget)
    const apiKeyPix = await getAsaasKey(db, ownerId).catch(() => null);
    if (apiKeyPix) {
      Promise.all(newCharges.map(({ chargeId, tenantId: tid, baseRent: amt, dueDate: dd }) =>
        createPixForCharge(db, chargeId, tid, amt, dd, apiKeyPix, ownerData).catch(e =>
          console.error('[PIX] handleAutoGenerateUpcoming:', e.message)
        )
      ));
    }

    const fmt         = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const transporter = nodemailer.createTransport({
      host: 'smtp.titan.email', port: 587, secure: false,
      auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
    });
    await Promise.all(newCharges.map(async ({ tenantEmail, baseRent, dueDate, monthStr }) => {
      if (!tenantEmail) return;
      const dueFmt = dueDate.toLocaleDateString('pt-BR');
      try {
        await transporter.sendMail({
          from:    'iLocarPay <denis@dlftech.com.br>',
          to:      tenantEmail,
          subject: `Nova cobrança de aluguel — ${fmt.format(baseRent)}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff">
              <div style="background:#1B5E20;padding:20px 28px;border-radius:12px 12px 0 0">
                <span style="color:#fff;font-weight:800;font-size:20px">iLocarPay</span>
              </div>
              <div style="padding:28px 28px 8px">
                <p style="color:#888;font-size:13px;margin:0 0 6px">NOVA COBRANÇA — ${monthStr}</p>
                <h2 style="color:#1a1a1a;margin:0 0 20px;font-size:24px">${fmt.format(baseRent)}</h2>
                <div style="background:#f8f8f8;border-radius:10px;padding:18px 20px;margin-bottom:24px">
                  <table style="width:100%;border-collapse:collapse">
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Referência</td>
                      <td style="font-weight:600;color:#1a1a1a;text-align:right;font-size:14px">${monthStr}</td>
                    </tr>
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Vencimento</td>
                      <td style="font-weight:600;color:#c62828;text-align:right;font-size:14px">${dueFmt}</td>
                    </tr>
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Valor</td>
                      <td style="font-weight:700;color:#1B5E20;text-align:right;font-size:15px">${fmt.format(baseRent)}</td>
                    </tr>
                  </table>
                </div>
                <div style="text-align:center;margin-bottom:24px">
                  <p style="color:#444;font-size:14px;margin-bottom:12px">Abra o app iLocarPay para gerar o QR Code PIX e pagar em segundos.</p>
                  <span style="display:inline-block;background:#1B5E20;color:#fff;font-weight:700;font-size:15px;padding:12px 32px;border-radius:8px">Pagar via iLocarPay</span>
                </div>
                <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
                <p style="color:#bbb;font-size:11px;text-align:center">Pague até ${dueFmt} para evitar multas e juros. Mensagem automática do iLocarPay.</p>
              </div>
            </div>
          `
        });
      } catch (_) {}
    }));
  }

  return { created };
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

  // Carrega config do owner para taxas personalizadas
  let ownerCfg = {};
  if (ownerId) {
    try { ownerCfg = (await db.collection('owners').doc(ownerId).get()).data() || {}; } catch (_) {}
  }

  const nowMs = Date.now();
  const batch = db.batch();

  overdue.forEach(d => {
    const data   = d.data();
    const dueSecs = data.dueDate?.seconds ?? data.dueDate?._seconds ?? 0;
    const dueDateMs = dueSecs * 1000;
    const diasAtraso = Math.max(1, Math.floor((nowMs - dueDateMs) / 86400000));

    // Aplica multa 2%, juros 1%/mês e correção monetária (IPCA-E ~0,35%/mês)
    const baseRent = data.baseRent || data.totalAmount || 0;
    const cfgFine       = (ownerCfg?.finePercentage          ?? 2)    / 100;
    const cfgInterest   = (ownerCfg?.interestRate             ?? 1)    / 100 / 30;
    const cfgCorrecao   = (ownerCfg?.monetaryCorrectionRate   ?? 0.35) / 100 / 30;
    const multaJaAplicada = (data.multaAplicada || 0) > 0;
    const multa    = multaJaAplicada ? (data.multaAplicada || 0) : baseRent * cfgFine;
    const juros    = baseRent * cfgInterest * diasAtraso;
    const correcao = baseRent * cfgCorrecao * diasAtraso;

    const extrasTotal = (data.extras || []).reduce((s, e) => s + (e.value || 0), 0);
    const totalAmount = baseRent + extrasTotal + multa + juros + correcao;

    batch.update(d.ref, {
      status:           'overdue',
      multaAplicada:    multa,
      jurosAplicado:    juros,
      correcaoAplicada: correcao,
      diasAtraso,
      totalAmount:      Math.round(totalAmount * 100) / 100
    });
  });

  await batch.commit();

  // Envia email de aviso de inadimplência para cada cobrança recém marcada
  try {
    const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const transporter = nodemailer.createTransport({
      host: 'smtp.titan.email', port: 587, secure: false,
      auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
    });
    await Promise.all(overdue.map(async d => {
      const data = d.data();
      const email = data.tenantEmail;
      if (!email) return;
      const dueSecs = data.dueDate?.seconds ?? data.dueDate?._seconds ?? 0;
      const dueFmt = new Date(dueSecs * 1000).toLocaleDateString('pt-BR');
      const base = data.baseRent || data.totalAmount || 0;
      const multa = base * 0.02;
      const diasAtraso = Math.max(1, Math.floor((Date.now() - dueSecs * 1000) / 86400000));
      const juros = base * 0.00033 * diasAtraso;
      const total = base + multa + juros;
      try {
        await transporter.sendMail({
          from: 'iLocarPay <denis@dlftech.com.br>',
          to: email,
          subject: `⚠️ Cobrança vencida — regularize agora`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff">
              <div style="background:#b71c1c;padding:20px 28px;border-radius:12px 12px 0 0">
                <span style="color:#fff;font-weight:800;font-size:20px">iiLocarPay</span>
                <span style="color:#ffcdd2;font-size:13px;margin-left:10px">⚠️ Cobrança Vencida</span>
              </div>
              <div style="padding:28px 28px 8px">
                <h2 style="color:#b71c1c;margin:0 0 8px">Sua cobrança está em atraso</h2>
                <p style="color:#555;font-size:14px;margin-bottom:20px">Regularize o pagamento para evitar o aumento das multas e juros.</p>
                <div style="background:#fff3f3;border:1px solid #ffcdd2;border-radius:10px;padding:18px 20px;margin-bottom:24px">
                  <table style="width:100%;border-collapse:collapse">
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Vencimento</td>
                      <td style="font-weight:600;color:#b71c1c;text-align:right;font-size:14px">${dueFmt}</td>
                    </tr>
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Aluguel base</td>
                      <td style="font-weight:600;color:#1a1a1a;text-align:right;font-size:14px">${fmt.format(base)}</td>
                    </tr>
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Multa (2%)</td>
                      <td style="font-weight:600;color:#e53935;text-align:right;font-size:14px">+ ${fmt.format(multa)}</td>
                    </tr>
                    <tr>
                      <td style="color:#777;font-size:14px;padding:4px 0">Juros (${diasAtraso} dia${diasAtraso > 1 ? 's' : ''})</td>
                      <td style="font-weight:600;color:#e53935;text-align:right;font-size:14px">+ ${fmt.format(juros)}</td>
                    </tr>
                    <tr style="border-top:1px solid #ffcdd2">
                      <td style="color:#b71c1c;font-size:15px;font-weight:700;padding:8px 0 4px">Total atual</td>
                      <td style="font-weight:800;color:#b71c1c;text-align:right;font-size:16px">${fmt.format(total)}</td>
                    </tr>
                  </table>
                </div>
                <div style="text-align:center;margin-bottom:24px">
                  <span style="display:inline-block;background:#b71c1c;color:#fff;font-weight:700;font-size:15px;padding:12px 32px;border-radius:8px">Regularizar no iiLocarPay</span>
                </div>
                <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
                <p style="color:#bbb;font-size:11px;text-align:center">Os juros aumentam a cada dia de atraso. Mensagem automática do iiLocarPay.</p>
              </div>
            </div>
          `
        });
      } catch (_) {}
    }));
  } catch (_) {}

  // Push FCM para cada tenant inadimplente
  try {
    const fmtVal = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    await Promise.all(overdue.map(async d => {
      const data = d.data();
      const tenantId = data.tenantId;
      if (!tenantId) return;
      try {
        const userSnap = await db.collection('users').doc(tenantId).get();
        const token = userSnap.data()?.fcmToken;
        if (!token) return;
        const base = data.baseRent || data.totalAmount || 0;
        const diasAtraso = Math.max(1, Math.floor((Date.now() - (data.dueDate?.seconds ?? 0) * 1000) / 86400000));
        await getMessaging().send({
          token,
          notification: {
            title: '⚠️ Aluguel em atraso',
            body: `Sua cobrança de ${fmtVal.format(base)} está vencida há ${diasAtraso} dia${diasAtraso > 1 ? 's' : ''}. Regularize agora.`
          },
          data: { type: 'reminder', chargeId: d.id },
          android: { priority: 'high' }
        });
      } catch (_) {}
    }));
  } catch (_) {}

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
      notification: { title: title || 'iiLocarPay', body: message || 'Você tem uma cobrança pendente.' },
      data: chargeId ? { chargeId, type: 'reminder' } : { type: 'reminder' },
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

  const defaultTitle = title || 'iiLocarPay — Cobrança pendente';
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
        data: info.chargeIds[0] ? { chargeId: info.chargeIds[0], type: 'reminder' } : { type: 'reminder' },
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

  const ownerSnap = charge.ownerId
    ? await db.collection('owners').doc(charge.ownerId).get()
    : null;
  const ownerName = ownerSnap?.exists ? (ownerSnap.data().name || 'Imobiliária') : 'Imobiliária';

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
    from: `iiLocarPay — ${ownerName} <denis@dlftech.com.br>`,
    to: user.email,
    subject: `Recibo de pagamento — ${monthRef}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fafafa">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
          <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
          <span style="font-size:18px;font-weight:700;color:#1a1a1a">iiLocarPay</span>
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
          <p style="color:#888;font-size:12px;text-align:center;margin:0">Pago em ${paidAt} • Gerado por iiLocarPay</p>
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
    from: 'iLocarPay <denis@dlftech.com.br>',
    to: owner.email,
    subject: `Relatório de ${monthName} — iiLocarPay`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fafafa">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
          <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
          <span style="font-size:18px;font-weight:700;color:#1a1a1a">iiLocarPay</span>
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
          Relatório gerado automaticamente pelo iiiLocarPay — ${new Date().toLocaleDateString('pt-BR')}
        </p>
      </div>`
  });

  await ownerSnap.ref.update({ lastReportSentAt: new Date(), lastReportMonth: target });
  return { ok: true, sentTo: owner.email, month: target, paid: paid.length, pending: pending.length + overdue.length, totalPaid };
}

// ── ANNUAL RENT ALERT ────────────────────────────────────────────────────────
// Verifica contratos ativos com 12 meses completos (ou múltiplos) sem reajuste
// registrado e notifica o owner por email.
async function handleAnnualRentAlert(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) return { ok: true, skipped: true };
  const owner = ownerSnap.data();
  if (!owner.email) return { ok: true, skipped: true };

  const now  = Date.now();
  const snap = await db.collection('contracts')
    .where('ownerId', '==', ownerId)
    .where('active', '==', true)
    .get();

  if (snap.empty) return { ok: true, alerted: 0 };

  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });

  const fmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtMoney = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  let alerted = 0;
  const batch = db.batch();

  for (const doc of snap.docs) {
    const c = doc.data();
    if (!c.startDate?.seconds) continue;

    const startMs    = c.startDate.seconds * 1000;
    const ageMonths  = (now - startMs) / (30.44 * 86_400_000);
    const lastAlert  = c.lastRentAdjustAlertMonths || 0;
    const nextAlert  = Math.floor(ageMonths / 12) * 12;

    // Alerta apenas quando atinge múltiplo de 12 e ainda não foi alertado
    if (nextAlert < 12 || nextAlert <= lastAlert) continue;
    // Janela: dentro de 5 dias do aniversário do contrato
    const daysIn = (ageMonths - nextAlert) * 30.44;
    if (daysIn > 5) continue;

    await transporter.sendMail({
      from: 'iLocarPay <denis@dlftech.com.br>',
      to: owner.email,
      subject: `📅 Reajuste anual do contrato — ${c.propertyDescription || 'Imóvel'}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fafafa">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
            <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
            <span style="font-size:18px;font-weight:700;color:#1a1a1a">iiLocarPay</span>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e8e8e8">
            <div style="text-align:center;margin-bottom:20px">
              <div style="font-size:36px">📅</div>
              <h2 style="color:#1a1a1a;margin:8px 0 4px">Reajuste anual disponível</h2>
              <p style="color:#888;margin:0;font-size:14px">O contrato completa ${nextAlert} meses</p>
            </div>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Imóvel</td>
                  <td style="padding:8px 0;text-align:right;font-weight:600;border-bottom:1px solid #eee">${c.propertyDescription || '—'}</td></tr>
              <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Início do contrato</td>
                  <td style="padding:8px 0;text-align:right;border-bottom:1px solid #eee">${fmt.format(new Date(startMs))}</td></tr>
              <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Aluguel atual</td>
                  <td style="padding:8px 0;text-align:right;font-weight:700;border-bottom:1px solid #eee">${fmtMoney(c.baseRent || 0)}</td></tr>
              <tr><td style="padding:8px 0;color:#555">Duração</td>
                  <td style="padding:8px 0;text-align:right">${nextAlert} meses</td></tr>
            </table>
            <div style="background:#f5f5f5;border-radius:8px;padding:14px;margin-top:20px;font-size:13px;color:#555">
              💡 De acordo com a Lei do Inquilinato (Art. 18), o aluguel pode ser reajustado anualmente pelo índice acordado em contrato (IPCA, IGP-M ou INPC).
              Acesse o app iiLocarPay → Ações rápidas → Reajuste para aplicar o novo valor.
            </div>
          </div>
          <p style="color:#aaa;font-size:11px;text-align:center;margin-top:20px">iiLocarPay — ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>`
    });

    batch.update(doc.ref, { lastRentAdjustAlertMonths: nextAlert });
    alerted++;
  }

  if (alerted > 0) await batch.commit();
  return { ok: true, alerted };
}

// ── CRON DAILY ───────────────────────────────────────────────────────────────
// Executado automaticamente pelo Vercel Cron às 10:00 BRT todos os dias.
// Itera todos os owners e executa: mark-overdue, notify-expiry, notify-upcoming.
// No dia 1 do mês também gera cobranças para todos os owners.
async function handleCronDaily(db, req) {
  // Vercel envia o header x-vercel-cron: 1 nos requests de cron
  const isCron = req.headers?.['x-vercel-cron'] === '1';
  const cronSecret = process.env.CRON_SECRET;
  if (!isCron && req.body?.secret !== cronSecret) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }

  const ownersSnap = await db.collection('owners').where('planActive', '==', true).get();
  if (ownersSnap.empty) return { ok: true, owners: 0 };

  const isFirstOfMonth = new Date().getDate() === 1;
  const results = { owners: ownersSnap.size, overdue: 0, expiry: 0, charges: 0, errors: [] };

  for (const ownerDoc of ownersSnap.docs) {
    const ownerId = ownerDoc.id;
    try {
      // 1. Marca inadimplentes
      const od = await handleMarkOverdue(db, { ownerId });
      results.overdue += od.marked || 0;
    } catch (e) { results.errors.push(`${ownerId}/overdue: ${e.message}`); }

    try {
      // 2. Avisa vencimento de contratos
      const ex = await handleNotifyContractExpiry(db, { ownerId });
      results.expiry += ex.alerted || 0;
    } catch (e) { results.errors.push(`${ownerId}/expiry: ${e.message}`); }

    try {
      // 3. Avisa cobranças vencendo em 3 dias
      await handleNotifyUpcoming(db, { ownerId });
    } catch (e) { results.errors.push(`${ownerId}/upcoming: ${e.message}`); }

    try {
      // 4. Alerta de reajuste anual para contratos que completam 12 meses
      await handleAnnualRentAlert(db, { ownerId });
    } catch (e) { results.errors.push(`${ownerId}/rent-alert: ${e.message}`); }

    try {
      // 4. Gera cobranças N dias antes do vencimento (por contrato, todo dia)
      const gc = await handleAutoGenerateUpcoming(db, { ownerId, ownerData: ownerDoc.data() });
      results.charges += gc.created || 0;
    } catch (e) { results.errors.push(`${ownerId}/generate: ${e.message}`); }

    try {
      // 5. Atualiza QR code PIX de cobranças vencidas (novo valor com multa/juros via Asaas)
      const pr = await handleRefreshOverduePixQr(db, { ownerId });
      results.pixRefreshed = (results.pixRefreshed || 0) + (pr.refreshed || 0);
    } catch (e) { results.errors.push(`${ownerId}/pix-refresh: ${e.message}`); }

    if (isFirstOfMonth) {
      try {
        // 5. Envia relatório do mês anterior
        const prev = new Date();
        prev.setDate(0); // último dia do mês anterior
        const prevRef = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
        await handleMonthlyReport(db, { ownerId, monthRef: prevRef });
      } catch (e) { results.errors.push(`${ownerId}/report: ${e.message}`); }
    }
  }

  console.log('cron-daily result:', JSON.stringify(results));
  return { ok: true, ...results };
}

// ── NOTIFY CONTRACT EXPIRY ────────────────────────────────────────────────────
// Verifica contratos ativos cujo endDate está em 30, 15 ou 7 dias e envia
// email + push ao owner. Idempotente: usa o campo expiryAlertsSent para não
// reenviar o mesmo alerta no mesmo dia.
async function handleNotifyContractExpiry(db, body) {
  const { ownerId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  const owner = ownerSnap.data();

  // Busca FCM token do owner: primeiro em owners (cadastro via /cadastro), fallback em users
  let ownerFcmToken = owner.fcmToken || null;
  if (!ownerFcmToken && owner.email) {
    const ownerUserSnap = await db.collection('users')
      .where('email', '==', owner.email).where('role', '==', 'admin').limit(1).get();
    ownerFcmToken = ownerUserSnap.docs[0]?.data()?.fcmToken || null;
  }

  const now       = Date.now();
  const thresholds = [7, 15, 30]; // dias antes do vencimento
  const msPerDay   = 86_400_000;

  const contractsSnap = await db.collection('contracts')
    .where('ownerId', '==', ownerId)
    .where('active', '==', true)
    .get();

  if (contractsSnap.empty) return { ok: true, checked: 0, alerted: 0 };

  // Busca nomes dos inquilinos em lote
  const tenantIds = [...new Set(contractsSnap.docs.map(d => d.data().tenantId).filter(Boolean))];
  const nameMap = {};
  for (let i = 0; i < tenantIds.length; i += 10) {
    const slice = tenantIds.slice(i, i + 10);
    const usersSnap = await db.collection('users').where('__name__', 'in', slice).get();
    usersSnap.docs.forEach(d => { nameMap[d.id] = d.data().name || d.data().email || d.id; });
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });

  const fmt     = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const batch   = db.batch();
  let alerted   = 0;

  for (const doc of contractsSnap.docs) {
    const contract = doc.data();
    if (!contract.endDate?.seconds) continue;

    const endMs       = contract.endDate.seconds * 1000;
    const daysLeft    = Math.ceil((endMs - now) / msPerDay);
    if (daysLeft < 0 || daysLeft > 30) continue;

    const alertKey = thresholds.find(t => daysLeft <= t);
    if (!alertKey) continue;

    const sentAlerts = contract.expiryAlertsSent || [];
    if (sentAlerts.includes(alertKey)) continue; // já enviado

    const tenantName = nameMap[contract.tenantId] || 'Inquilino';
    const endFmt     = fmt.format(new Date(endMs));

    // Email ao owner
    if (owner.email) {
      await transporter.sendMail({
        from: 'iLocarPay <denis@dlftech.com.br>',
        to: owner.email,
        subject: `⚠️ Contrato vence em ${daysLeft} dia${daysLeft !== 1 ? 's' : ''} — ${tenantName}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fafafa">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
              <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
              <span style="font-size:18px;font-weight:700;color:#1a1a1a">iiLocarPay</span>
            </div>
            <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e8e8e8">
              <div style="text-align:center;margin-bottom:20px">
                <div style="font-size:36px">⚠️</div>
                <h2 style="color:#e65100;margin:8px 0 4px">Contrato próximo do vencimento</h2>
                <p style="color:#888;margin:0;font-size:14px">Ação necessária</p>
              </div>
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Inquilino</td>
                    <td style="padding:8px 0;text-align:right;font-weight:600;border-bottom:1px solid #eee">${tenantName}</td></tr>
                <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Imóvel</td>
                    <td style="padding:8px 0;text-align:right;border-bottom:1px solid #eee">${contract.propertyDescription || '—'}</td></tr>
                <tr><td style="padding:8px 0;color:#555;border-bottom:1px solid #eee">Término do contrato</td>
                    <td style="padding:8px 0;text-align:right;font-weight:700;color:#e65100;border-bottom:1px solid #eee">${endFmt}</td></tr>
                <tr><td style="padding:8px 0;color:#555">Dias restantes</td>
                    <td style="padding:8px 0;text-align:right;font-weight:800;font-size:20px;color:#e65100">${daysLeft} dia${daysLeft !== 1 ? 's' : ''}</td></tr>
              </table>
              <p style="color:#888;font-size:13px;margin-top:20px">
                Acesse o iiLocarPay para renovar o contrato ou comunicar a saída do inquilino.
              </p>
            </div>
            <p style="color:#aaa;font-size:11px;text-align:center;margin-top:20px">iiLocarPay — ${new Date().toLocaleDateString('pt-BR')}</p>
          </div>`
      });
    }

    // Push ao owner
    if (ownerFcmToken) {
      try {
        await getMessaging().send({
          token: ownerFcmToken,
          notification: {
            title: `⚠️ Contrato vence em ${daysLeft} dia${daysLeft !== 1 ? 's' : ''}`,
            body: `${tenantName} — ${contract.propertyDescription || 'Imóvel'}`
          },
          data: { type: 'contract_expiry', contractId: doc.id }
        });
      } catch (_) {}
    }

    // Marca alerta como enviado
    batch.update(doc.ref, {
      expiryAlertsSent: [...sentAlerts, alertKey]
    });
    alerted++;
  }

  if (alerted > 0) await batch.commit();
  return { ok: true, checked: contractsSnap.size, alerted };
}

// ── ANNUAL RECEIPT ───────────────────────────────────────────────────────────
// Envia comprovante anual de pagamentos para cada inquilino (útil para IR)
// Parâmetros: { ownerId, year? (padrão: ano atual), tenantId? (opcional — só um) }
async function handleAnnualReceipt(db, body) {
  const { ownerId, tenantId } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const year = body.year ? parseInt(body.year, 10) : new Date().getFullYear();
  const startTs = new Date(year, 0, 1);
  const endTs   = new Date(year + 1, 0, 1);

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  const ownerName = ownerSnap.exists ? (ownerSnap.data().name || 'Imobiliária') : 'Imobiliária';

  let q = db.collection('charges')
    .where('ownerId', '==', ownerId)
    .where('status', '==', 'paid');
  if (tenantId) q = q.where('tenantId', '==', tenantId);

  const snap = await q.get();
  if (snap.empty) return { ok: true, skipped: true, reason: 'sem_pagamentos_no_ano', year };

  // Filtra pelo ano via paidAt (Firestore não suporta between em dois campos distintos)
  const charges = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => {
      const paidAt = c.paidAt?.seconds ? new Date(c.paidAt.seconds * 1000) : null;
      return paidAt && paidAt >= startTs && paidAt < endTs;
    });

  if (charges.length === 0) return { ok: true, skipped: true, reason: 'sem_pagamentos_no_ano', year };

  // Agrupa por tenantId
  const byTenant = {};
  for (const c of charges) {
    const tid = c.tenantId || c.tenantEmail || 'unknown';
    if (!byTenant[tid]) byTenant[tid] = [];
    byTenant[tid].push(c);
  }

  // Busca dados dos inquilinos
  const tenantIds = Object.keys(byTenant).filter(id => id !== 'unknown' && !id.includes('@'));
  const nameMap = {}, emailMap = {};
  for (let i = 0; i < tenantIds.length; i += 10) {
    const slice = tenantIds.slice(i, i + 10);
    const usersSnap = await db.collection('users').where('__name__', 'in', slice).get();
    usersSnap.docs.forEach(d => {
      nameMap[d.id]  = d.data().name  || d.data().email || d.id;
      emailMap[d.id] = d.data().email || '';
    });
  }

  const fmt     = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtDate = secs => secs ? new Date(secs * 1000).toLocaleDateString('pt-BR') : '—';
  const months  = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });

  let sent = 0;
  for (const [tid, tenantCharges] of Object.entries(byTenant)) {
    const toEmail = emailMap[tid] || (tid.includes('@') ? tid : null);
    if (!toEmail) continue;

    const tenantName = nameMap[tid] || toEmail;
    const totalPago  = tenantCharges.reduce((s, c) => s + (c.totalAmount || 0), 0);

    // Ordenar por mês
    tenantCharges.sort((a, b) => (a.paidAt?.seconds || 0) - (b.paidAt?.seconds || 0));

    const rows = tenantCharges.map((c, i) => {
      const paidAt = c.paidAt?.seconds ? new Date(c.paidAt.seconds * 1000) : null;
      const mesRef = paidAt ? `${months[paidAt.getMonth()]}/${year}` : (c.monthRef || '—');
      const bg = i % 2 === 0 ? '#fff' : '#f9f9f9';
      return `<tr style="background:${bg}">
        <td style="padding:8px 12px">${mesRef}</td>
        <td style="padding:8px 12px">${c.propertyDescription || '—'}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600;color:#2D6A2D">${fmt(c.totalAmount || 0)}</td>
        <td style="padding:8px 12px;color:#777;font-size:12px">${fmtDate(c.paidAt?.seconds)}</td>
      </tr>`;
    }).join('');

    await transporter.sendMail({
      from: `iiLocarPay — ${ownerName} <denis@dlftech.com.br>`,
      to: toEmail,
      subject: `Comprovante anual de aluguéis ${year} — iiLocarPay`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fafafa">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
            <div style="background:#2D6A2D;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">L</div>
            <span style="font-size:18px;font-weight:700;color:#1a1a1a">iiLocarPay</span>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e8e8e8">
            <div style="text-align:center;margin-bottom:24px">
              <div style="font-size:40px;margin-bottom:8px">📋</div>
              <h2 style="color:#1a1a1a;margin:0 0 4px">Comprovante Anual ${year}</h2>
              <p style="color:#888;margin:0;font-size:14px">${tenantName}</p>
            </div>

            <div style="background:#f0f7f0;border-radius:10px;padding:16px;text-align:center;margin-bottom:24px">
              <div style="font-size:12px;color:#555;margin-bottom:4px">TOTAL PAGO EM ${year}</div>
              <div style="font-size:28px;font-weight:800;color:#2D6A2D">${fmt(totalPago)}</div>
              <div style="font-size:12px;color:#777">${tenantCharges.length} pagamento${tenantCharges.length !== 1 ? 's' : ''} realizados</div>
            </div>

            <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #e8e8e8;border-radius:8px;overflow:hidden">
              <thead>
                <tr style="background:#f5f5f5">
                  <th style="padding:10px 12px;text-align:left;font-weight:600;color:#555">Referência</th>
                  <th style="padding:10px 12px;text-align:left;font-weight:600;color:#555">Imóvel</th>
                  <th style="padding:10px 12px;text-align:right;font-weight:600;color:#555">Valor</th>
                  <th style="padding:10px 12px;text-align:left;font-weight:600;color:#555">Pago em</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr style="background:#f0f7f0">
                  <td colspan="2" style="padding:12px;font-weight:700">Total</td>
                  <td style="padding:12px;text-align:right;font-weight:800;color:#2D6A2D;font-size:16px">${fmt(totalPago)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>

            <p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px">
              Este documento comprova os pagamentos de aluguel realizados em ${year}.<br>
              Gerado automaticamente por iiiLocarPay — ${new Date().toLocaleDateString('pt-BR')}
            </p>
          </div>
          <p style="color:#aaa;font-size:11px;text-align:center;margin-top:16px">Em caso de dúvidas, entre em contato com ${ownerName}.</p>
        </div>`
    });
    sent++;
  }

  return { ok: true, year, sent, total: Object.keys(byTenant).length };
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
          data: { type: 'paid', chargeId: chargeDoc.id },
          android: { priority: 'high' }
        });
      }
    }
  } catch (_) {}

  // Email de recibo para o inquilino (fire-and-forget)
  if (charge.tenantId) {
    handleSendReceipt(db, { chargeId: chargeDoc.id, tenantId: charge.tenantId }).catch(() => {});
  }

  // Push de notificação ao proprietário
  const ownerId = charge.ownerId;
  try {
    if (ownerId) {
      const [ownerSnap, tenantSnap] = await Promise.all([
        db.collection('owners').doc(ownerId).get(),
        charge.tenantId ? db.collection('users').doc(charge.tenantId).get() : Promise.resolve(null)
      ]);
      const ownerEmail = ownerSnap.data()?.email;
      const tenantName = tenantSnap?.data()?.name || 'Inquilino';
      if (ownerEmail) {
        const ownerUserSnap = await db.collection('users')
          .where('email', '==', ownerEmail)
          .where('role', '==', 'admin')
          .limit(1)
          .get();
        const ownerToken = ownerUserSnap.docs[0]?.data()?.fcmToken;
        if (ownerToken) {
          const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
          await getMessaging().send({
            token: ownerToken,
            notification: {
              title: '💰 Pagamento recebido!',
              body: `${tenantName} pagou ${fmt.format(charge.totalAmount || 0)}`
            },
            data: { type: 'admin', chargeId: chargeDoc.id },
            android: { priority: 'high' }
          });
        }
      }
    }
  } catch (_) {}

  // Gera próxima cobrança do mês seguinte
  if (ownerId) {
    await handleGenerateCharges(db, { ownerId, monthOffset: 1 }).catch(() => {});
  }

  return { ok: true, event, chargeId: chargeDoc.id, action: 'marked_paid' };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
// ── SYNC SIGNATURES (Assinafy) ──────────────────────────────────────────────
// Legado: POST /api/locarpay-sync-status → reescrito para /api/locarpay-card
const _ASSINAFY_DONE    = ['completed','signed','finished','done','approved','executed','manual','concluded','closed','active','certificated'];
const _ASSINAFY_SIGNED  = ['signed','completed','approved','finished','done','concluded','active'];

async function handleSyncSignatures(db, body) {
  const { tenantEmail, contractId } = body || {};
  if (!tenantEmail && !contractId) throw Object.assign(new Error('tenantEmail ou contractId obrigatório'), { status: 400 });

  let contractSnap;
  if (contractId) {
    const doc = await db.collection('contracts').doc(contractId).get();
    contractSnap = doc.exists ? { empty: false, docs: [doc] } : { empty: true };
  } else {
    const email = tenantEmail.toLowerCase().trim();
    const snap  = await db.collection('contracts').where('tenantEmail', '==', email).where('active', '==', true).limit(1).get();
    contractSnap = snap;
  }
  if (contractSnap.empty) throw Object.assign(new Error('Contrato não encontrado'), { status: 404 });

  const contractDoc = contractSnap.docs[0];
  const contract    = contractDoc.data();

  if (_ASSINAFY_DONE.includes((contract.assinafyStatus || '').toLowerCase()))
    return { signed: true, status: contract.assinafyStatus };

  const documentId   = contract.assinafyDocumentId;
  const assignmentId = contract.assinafyAssignmentId;
  if (!documentId) return { signed: false, status: 'no_document' };

  const configDoc = await db.collection('config').doc('assinafy').get();
  const apiKey    = configDoc.exists ? configDoc.data().apiKey : null;
  if (!apiKey) return { signed: false, status: 'no_api_key' };

  async function afFetch(path) {
    const r    = await fetch(`https://api.assinafy.com.br/v1/${path}`, { headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' } });
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch { return { ok: r.ok, status: r.status, data: text }; }
  }

  const accountsRes = await afFetch('accounts');
  const accountId   = accountsRes.data?.data?.[0]?.id;
  if (!accountId) return { signed: false, status: 'no_account' };

  const docRes    = await afFetch(`accounts/${accountId}/documents/${documentId}`);
  const docStatus = (docRes.data?.data?.status || '').toLowerCase();
  if (_ASSINAFY_DONE.some(s => docStatus.includes(s))) {
    const updates = { assinafyStatus: 'completed', ownerSigned: true };
    const signedUrl = docRes.data?.data?.signed_url || docRes.data?.data?.signedUrl;
    if (signedUrl) updates.signedFileUrl = signedUrl;
    await contractDoc.ref.update(updates);
    return { signed: true, status: 'completed' };
  }

  if (assignmentId) {
    const assignRes = await afFetch(`accounts/${accountId}/documents/${documentId}/assignments/${assignmentId}`);
    const signers   = assignRes.data?.data?.signers || [];
    const ownerSigner  = signers.find(s => s.step === 1) || signers[0];
    const tenantSigner = signers.find(s => s.step === 2) || signers[1];
    const ownerSignedApi  = ownerSigner?.signed_at  != null || _ASSINAFY_SIGNED.includes((ownerSigner?.status  || '').toLowerCase());
    const tenantSignedApi = tenantSigner?.signed_at != null || _ASSINAFY_SIGNED.includes((tenantSigner?.status || '').toLowerCase());

    if (ownerSignedApi && tenantSignedApi) {
      await contractDoc.ref.update({ assinafyStatus: 'completed', ownerSigned: true });
      return { signed: true, status: 'completed' };
    }
    if (ownerSignedApi && !contract.ownerSigned) await contractDoc.ref.update({ ownerSigned: true });
    return {
      signed:        false,
      ownerSigned:   ownerSignedApi || contract.ownerSigned || false,
      tenantSigned:  tenantSignedApi,
      tenantSignUrl: !tenantSignedApi ? (tenantSigner?.sign_url || null) : null,
    };
  }
  return { signed: false, status: docStatus || 'pending' };
}

// Revoga token do inquilino — funciona em qualquer versao do app instalado
async function handleRevokeTenant(db, body, req) {
  const { tenantId } = body;
  if (!tenantId) throw new Error('tenantId obrigatorio');

  // Verifica que o chamador e um owner valido (Firebase ID token no header)
  const idToken = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!idToken) throw Object.assign(new Error('Nao autorizado'), { status: 401 });

  const decoded = await getAuth().verifyIdToken(idToken);
  const callerUid = decoded.uid;

  // Confirma que o caller e owner do inquilino
  const ownerSnap = await db.collection('owners')
    .where('adminUid', '==', callerUid).limit(1).get();
  const tenantRef = db.collection('users').doc(tenantId);
  const tenantSnap = await tenantRef.get();

  if (!tenantSnap.exists) throw Object.assign(new Error('Inquilino nao encontrado'), { status: 404 });

  // Aceita se for owner cadastrado OU se o inquilino pertence a qualquer owner (fallback)
  // Marca como suspenso imediatamente — dispara listener no app
  await tenantRef.update({ suspended: true });

  // Revoga refresh tokens do Firebase Auth — invalida sessao em qualquer versao do app
  const email = tenantSnap.data().email;
  if (email) {
    try {
      const fbUser = await getAuth().getUserByEmail(email);
      await getAuth().revokeRefreshTokens(fbUser.uid);
    } catch (_) {}
  }

  return { ok: true, message: 'Sessao do inquilino invalidada.' };
}

// Cria PIX Asaas para um documento de extra já criado no Firestore.
// Taxa de cartão repassada ao inquilino via `enableDunning: true` e sem subsídio do owner.
async function handleCreateExtraPix(db, body) {
  const { chargeId, ownerId } = body;
  if (!chargeId || !ownerId) throw Object.assign(new Error('chargeId e ownerId obrigatórios'), { status: 400 });

  const chargeSnap = await db.collection('charges').doc(chargeId).get();
  if (!chargeSnap.exists) throw Object.assign(new Error('Extra não encontrado'), { status: 404 });
  const charge = chargeSnap.data();
  if (charge.asaasChargeId) return { ok: true, skipped: 'PIX já gerado' };

  const apiKey = await getAsaasKey(db, ownerId);
  if (!apiKey) throw Object.assign(new Error('Chave Asaas não configurada'), { status: 500 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  const ownerCfg = ownerSnap.data() || {};
  const fineVal     = ownerCfg.finePercentage  ?? 2;
  const interestVal = ownerCfg.interestRate     ?? 1;

  const dueDate = charge.dueDate instanceof Date ? charge.dueDate : new Date((charge.dueDate?.seconds || 0) * 1000);
  const dueDateStr = `${dueDate.getFullYear()}-${String(dueDate.getMonth()+1).padStart(2,'0')}-${String(dueDate.getDate()).padStart(2,'0')}`;

  const customerId = await (async () => {
    const tSnap = await db.collection('users').doc(charge.tenantId).get();
    const t = tSnap.data() || {};
    return findOrCreateCustomer(t.name || t.email, t.email, t.cpf || t.document, t.phone, apiKey);
  })();

  const pixBody = {
    customer:    customerId,
    billingType: 'PIX',
    value:       parseFloat((charge.totalAmount || charge.baseRent || 0).toFixed(2)),
    dueDate:     dueDateStr,
    description: charge.description || 'Extra iLocarPay',
    fine:        { value: fineVal },
    interest:    { value: interestVal },
  };

  let res;
  try { res = await asaasReq('POST', '/payments', pixBody, apiKey); }
  catch (e) { throw Object.assign(new Error('Asaas: ' + e.message), { status: 502 }); }

  const pixQrRes = await asaasReq('GET', `/payments/${res.id}/pixQrCode`, null, apiKey).catch(() => null);

  await db.collection('charges').doc(chargeId).update({
    asaasChargeId: res.id,
    pixQrCode:     pixQrRes?.encodedImage || res.pixQrCode    || '',
    pixCopyPaste:  pixQrRes?.payload      || res.pixCopyPaste || '',
    pixExpiresAt:  pixQrRes?.expirationDate ? new Date(pixQrRes.expirationDate) : null,
  });

  return { ok: true, asaasChargeId: res.id };
}

async function handleMigrateTenantUid(db, body) {
  const { uid, email } = body;
  if (!uid || !email) throw new Error('uid e email obrigatórios');

  // Se users/{uid} já existe, nada a fazer
  const uidDoc = await db.collection('users').doc(uid).get();
  if (uidDoc.exists) return { ok: true, migrated: false };

  // Busca doc antigo pelo e-mail
  const snap = await db.collection('users')
    .where('email', '==', email.trim().toLowerCase())
    .where('role', '==', 'tenant')
    .limit(1).get();
  if (snap.empty) return { ok: true, migrated: false, reason: 'no_old_doc' };

  const oldDoc = snap.docs[0];
  const oldId  = oldDoc.id;
  if (oldId === uid) return { ok: true, migrated: false };

  const data = oldDoc.data();

  // Cria users/{uid} com os dados do doc antigo
  await db.collection('users').doc(uid).set({ ...data, id: uid });

  // Atualiza cobranças com tenantId antigo
  const chargesSnap = await db.collection('charges')
    .where('tenantId', '==', oldId).get();
  const batch1 = db.batch();
  chargesSnap.docs.forEach(d => batch1.update(d.ref, { tenantId: uid }));
  if (!chargesSnap.empty) await batch1.commit();

  // Atualiza contratos com tenantId antigo
  const contractsSnap = await db.collection('contracts')
    .where('tenantId', '==', oldId).get();
  const batch2 = db.batch();
  contractsSnap.docs.forEach(d => batch2.update(d.ref, { tenantId: uid }));
  if (!contractsSnap.empty) await batch2.commit();

  // Remove doc antigo
  await db.collection('users').doc(oldId).delete();

  return { ok: true, migrated: true, oldId, chargesUpdated: chargesSnap.size, contractsUpdated: contractsSnap.size };
}

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
            error: 'Plano expirado. Acesse o painel iLocarPay para renovar a assinatura.',
            reason: plan.reason
          });
        }
      }
    }

    if (step === 'init')           return res.status(200).json(await handleInit(db, req.body, null));
    if (step === 'verify-amount')  return res.status(200).json(await handleVerifyAmount(db, req.body, req));
    if (step === 'confirm')        return res.status(200).json(await handleConfirm(db, req.body));
    if (step === 'refund')         return res.status(200).json(await handleRefund(db, req.body));
    if (step === 'preview')        return res.status(200).json(await handlePreview(db, req.body));
    if (step === 'list-saved')     return res.status(200).json(await handleListSaved(db, req.body));
    if (step === 'delete-saved')   return res.status(200).json(await handleDeleteSaved(db, req.body));
    if (step === 'sync-status')    return res.status(200).json(await handleSyncStatus(db, req.body));
    if (step === 'sync-customers') return res.status(200).json(await handleSyncCustomers(db, req.body));
    if (step === 'check-terms')    return res.status(200).json(await handleCheckTerms(db, req.body));
    if (step === 'accept-terms')        return res.status(200).json(await handleAcceptTerms(db, req.body, req));
    if (step === 'check-contract-status') return res.status(200).json(await handleCheckContractStatus(db, req.body));
    if (step === 'mark-overdue')      return res.status(200).json(await handleMarkOverdue(db, req.body));
    if (step === 'send-push')         return res.status(200).json(await handleSendPush(db, req.body));
    if (step === 'generate-charges')  return res.status(200).json(await handleGenerateCharges(db, req.body));
    if (step === 'notify-upcoming')   return res.status(200).json(await handleNotifyUpcoming(db, req.body));
    if (step === 'send-receipt')      return res.status(200).json(await handleSendReceipt(db, req.body));
    if (step === 'close-contract')    return res.status(200).json(await handleCloseContract(db, req.body));
    if (step === 'adjust-rent')       return res.status(200).json(await handleAdjustRent(db, req.body));
    if (step === 'monthly-report')    return res.status(200).json(await handleMonthlyReport(db, req.body));
    if (step === 'asaas-webhook')     return res.status(200).json(await handleAsaasPaymentWebhook(db, req.body));
    if (step === 'annual-receipt')       return res.status(200).json(await handleAnnualReceipt(db, req.body));
    if (step === 'notify-expiry')        return res.status(200).json(await handleNotifyContractExpiry(db, req.body));
    if (step === 'cron-daily')           return res.status(200).json(await handleCronDaily(db, req));
    if (step === 'revoke-tenant')        return res.status(200).json(await handleRevokeTenant(db, req.body, req));
    if (step === 'create-extra-pix')     return res.status(200).json(await handleCreateExtraPix(db, req.body));
    if (step === 'migrate-tenant-uid')   return res.status(200).json(await handleMigrateTenantUid(db, req.body));

    // Webhook Asaas sem step (evento direto da subconta)
    if (!step && req.body?.event && req.body?.payment) {
      const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
      if (webhookToken) {
        const sentToken = req.headers['asaas-access-token'];
        if (sentToken !== webhookToken) {
          return res.status(401).json({ error: 'Webhook token inválido' });
        }
      }
      return res.status(200).json(await handleAsaasPaymentWebhook(db, req.body));
    }

    // Rota legada: /api/locarpay-sync-status → verifica assinaturas Assinafy
    if (!step && (req.body?.tenantEmail || req.body?.contractId)) {
      return res.status(200).json(await handleSyncSignatures(db, req.body));
    }

    return res.status(400).json({ error: 'step inválido' });

  } catch (e) {
    console.error('locarpay-card error:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
