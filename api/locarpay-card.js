// POST /api/locarpay-card
// step:"init"    → { tenantId, chargeId, card } → cobra micro-valor, retorna { verificationId }
// step:"confirm" → { verificationId, amount }   → verifica valor, estorna micro, cobra aluguel

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';

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

  const [userSnap, chargeSnap, configSnap] = await Promise.all([
    db.collection('users').doc(tenantId).get(),
    db.collection('charges').doc(chargeId).get(),
    db.collection('config').doc('asaas').get()
  ]);
  if (!userSnap.exists)   throw Object.assign(new Error('Inquilino não encontrado'), { status: 404 });
  if (!chargeSnap.exists) throw Object.assign(new Error('Cobrança não encontrada'),  { status: 404 });

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

  const verRef = db.collection('cardVerifications').doc();
  const expMonth = expiryMonth ? expiryMonth.padStart(2, '0') : (savedCardFallback?.expiryMonth || '');
  const expYear  = expiryYear  ? (expiryYear.length === 2 ? `20${expiryYear}` : expiryYear) : (savedCardFallback?.expiryYear || '');

  const verData = {
    tenantId,
    chargeId,
    customerId,
    expectedAmount: microValue,
    cardToken,
    asaasVerifyId:  asaasCharge.id,
    holderName,
    expiryMonth:    expMonth,
    expiryYear:     expYear,
    postalCode:     (postalCode || '').replace(/\D/g, ''),
    addressNumber:  addressNumber || 'SN',
    attempts:       0,
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

  return { verificationId: verRef.id };
}

// ── CONFIRM ──────────────────────────────────────────────────────────────────
async function handleConfirm(db, body, apiKey) {
  const { verificationId, amount } = body;
  if (!verificationId || amount == null)
    throw Object.assign(new Error('verificationId e amount obrigatórios'), { status: 400 });

  const verRef  = db.collection('cardVerifications').doc(verificationId);
  const verSnap = await verRef.get();
  if (!verSnap.exists) throw Object.assign(new Error('Verificação não encontrada'), { status: 404 });

  const ver = verSnap.data();

  if (ver.verified)
    throw Object.assign(new Error('Cartão já verificado'), { status: 400 });

  if (ver.attempts >= 5)
    throw Object.assign(new Error('Número máximo de tentativas atingido. Recadastre o cartão.'), { status: 400 });

  if (new Date() > ver.expiresAt.toDate())
    throw Object.assign(new Error('Verificação expirada. Recadastre o cartão.'), { status: 400 });

  const enteredAmount = parseFloat(parseFloat(amount).toFixed(2));
  if (Math.abs(enteredAmount - ver.expectedAmount) > 0.005) {
    await verRef.update({ attempts: FieldValue.increment(1) });
    const remaining = 5 - (ver.attempts + 1);
    throw Object.assign(
      new Error(`Valor incorreto. Você tem ${remaining} tentativa(s) restante(s).`),
      { status: 422 }
    );
  }

  // Valor correto — cancela a micro-cobrança (ainda PENDING → cancelamento imediato,
  // sem aparecer na fatura; se já capturada, faz estorno como fallback)
  if (ver.asaasVerifyId) {
    try {
      await asaasReq('POST', `/payments/${ver.asaasVerifyId}/cancel`, {}, apiKey);
    } catch (_) {
      try {
        await asaasReq('POST', `/payments/${ver.asaasVerifyId}/refunds`, {}, apiKey);
      } catch (_2) { /* ignora se já cancelado/estornado */ }
    }
  }

  // Cobra o aluguel real
  const [chargeSnap, configSnap2] = await Promise.all([
    db.collection('charges').doc(ver.chargeId).get(),
    db.collection('config').doc('asaas').get()
  ]);
  const charge = chargeSnap.data();
  const configData = configSnap2.data() || {};

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
async function handleRefund(db, body, apiKey) {
  const { chargeId } = body;
  if (!chargeId) throw Object.assign(new Error('chargeId obrigatório'), { status: 400 });

  const chargeSnap = await db.collection('charges').doc(chargeId).get();
  if (!chargeSnap.exists) throw Object.assign(new Error('Cobrança não encontrada'), { status: 404 });

  const charge = chargeSnap.data();

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

  const [chargeSnap, configSnap] = await Promise.all([
    db.collection('charges').doc(chargeId).get(),
    db.collection('config').doc('asaas').get()
  ]);
  if (!chargeSnap.exists) throw Object.assign(new Error('Cobrança não encontrada'), { status: 404 });

  const charge = chargeSnap.data();
  const cfg = configSnap.data() || {};

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
async function handleSyncCustomers(db, apiKey) {
  const usersSnap = await db.collection('users').get();
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

// ── SYNC STATUS ──────────────────────────────────────────────────────────────
async function handleSyncStatus(db, apiKey) {
  // Busca todas as cobranças "paid" que têm asaasChargeId
  const snap = await db.collection('charges')
    .where('status', '==', 'paid')
    .get();

  const toReset = [];

  await Promise.all(snap.docs.map(async (doc) => {
    const data = doc.data();
    if (!data.asaasChargeId) return;
    try {
      const payment = await asaasReq('GET', `/payments/${data.asaasChargeId}`, null, apiKey);
      // REFUNDED ou CHARGEBACK = estorno confirmado no Asaas
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
    } catch (_) { /* ignora cobranças que não existem mais no Asaas */ }
  }));

  return { ok: true, updated: toReset.length, chargeIds: toReset };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();

    const configSnap = await db.collection('config').doc('asaas').get();
    const apiKey     = configSnap.data()?.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'Chave Asaas não configurada' });

    const { step } = req.body || {};

    if (step === 'init')         return res.status(200).json(await handleInit(db, req.body, apiKey));
    if (step === 'confirm')      return res.status(200).json(await handleConfirm(db, req.body, apiKey));
    if (step === 'refund')       return res.status(200).json(await handleRefund(db, req.body, apiKey));
    if (step === 'preview')      return res.status(200).json(await handlePreview(db, req.body));
    if (step === 'list-saved')   return res.status(200).json(await handleListSaved(db, req.body));
    if (step === 'delete-saved') return res.status(200).json(await handleDeleteSaved(db, req.body));
    if (step === 'sync-status')    return res.status(200).json(await handleSyncStatus(db, apiKey));
    if (step === 'sync-customers') return res.status(200).json(await handleSyncCustomers(db, apiKey));
    return res.status(400).json({ error: 'step inválido' });

  } catch (e) {
    console.error('locarpay-card error:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
