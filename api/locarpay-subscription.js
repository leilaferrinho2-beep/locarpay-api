// POST /api/locarpay-subscription
// Pagamento de assinatura iLocarPay para imobiliárias (owners)
// step:"pix"          → { ownerId, plan } → cria PIX, retorna copyPaste + qrCode
// step:"check-pix"    → { paymentId, ownerId, plan } → verifica se pago, ativa plano
// step:"card-init"    → { ownerId, plan, card } → micro-cobrança R$1-9, retorna verificationId
// step:"card-verify"  → { verificationId, userAmount, ownerId } → verifica valor, estorna micro
// step:"card-confirm" → { verificationId, ownerId, plan } → cobra valor real, ativa plano

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

const PLANS = {
  basic: { name: 'Basic', price: 49.00 },
  pro:   { name: 'Pro',   price: 99.00 }
};

async function getMainAsaasKey(db) {
  const snap = await db.collection('config').doc('asaas').get();
  return snap.data()?.apiKey;
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
  const cpfD   = (cpf   || '').replace(/\D/g, '');
  const phoneD = (phone || '').replace(/\D/g, '');
  const search = await fetch(
    `https://api.asaas.com/v3/customers?email=${encodeURIComponent(email)}&limit=1`,
    { headers: { 'access_token': apiKey } }
  );
  const { data } = await search.json();
  if (data?.length > 0) return data[0].id;
  const c = await asaasReq('POST', '/customers', {
    name: name || email.split('@')[0],
    email,
    ...((cpfD.length === 11 || cpfD.length === 14) ? { cpfCnpj: cpfD } : {}),
    ...(phoneD.length >= 10  ? { mobilePhone: phoneD } : {})
  }, apiKey);
  return c.id;
}

async function activatePlan(db, ownerId, plan) {
  const until = new Date();
  until.setDate(until.getDate() + 30);
  await db.collection('owners').doc(ownerId).update({
    status:          'active',
    plan,
    planActiveUntil: until,
    billingStatus:   'active',
    updatedAt:       FieldValue.serverTimestamp()
  });
}

async function cancelOrRefund(paymentId, apiKey) {
  try { await asaasReq('POST', `/payments/${paymentId}/cancel`, {}, apiKey); return; } catch (_) {}
  try { await asaasReq('POST', `/payments/${paymentId}/refund`, {}, apiKey); } catch (_) {}
}

// ── PIX ──────────────────────────────────────────────────────────────────────
async function handlePix(db, body) {
  const { ownerId, plan, cpfCnpj } = body;
  if (!ownerId || !PLANS[plan]) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const apiKey   = await getMainAsaasKey(db);
  if (!apiKey) throw Object.assign(new Error('Chave Asaas não configurada'), { status: 500 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });
  const owner = ownerSnap.data();

  const effectiveCpf = (cpfCnpj || owner.cpf || owner.cnpj || '').replace(/\D/g, '');
  if (!effectiveCpf) throw Object.assign(new Error('CPF ou CNPJ do responsável obrigatório'), { status: 400 });

  const customerId = await findOrCreateCustomer(owner.name, owner.email, effectiveCpf, owner.phone, apiKey);

  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate  = tomorrow.toISOString().slice(0, 10);

  const charge = await asaasReq('POST', '/payments', {
    customer:    customerId,
    billingType: 'PIX',
    value:       PLANS[plan].price,
    dueDate,
    description: `iLocarPay — Plano ${PLANS[plan].name}`
  }, apiKey);

  // Busca QR code
  let pixCopyPaste = '', pixQrCode = '';
  try {
    const pix = await asaasReq('GET', `/payments/${charge.id}/pixQrCode`, null, apiKey);
    pixCopyPaste = pix.payload || '';
    pixQrCode    = pix.encodedImage || '';
  } catch (_) {}

  return { paymentId: charge.id, pixCopyPaste, pixQrCode, value: PLANS[plan].price, planName: PLANS[plan].name };
}

// ── CHECK PIX ─────────────────────────────────────────────────────────────────
async function handleCheckPix(db, body) {
  const { paymentId, ownerId, plan } = body;
  if (!paymentId || !ownerId) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const apiKey = await getMainAsaasKey(db);
  const charge = await asaasReq('GET', `/payments/${paymentId}`, null, apiKey);

  if (charge.status === 'RECEIVED' || charge.status === 'CONFIRMED') {
    await activatePlan(db, ownerId, plan);
    return { paid: true, plan };
  }
  return { paid: false, status: charge.status };
}

// ── CARD INIT ─────────────────────────────────────────────────────────────────
async function handleCardInit(db, body) {
  const { ownerId, plan, card } = body;
  if (!ownerId || !PLANS[plan] || !card) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const { holderName, number, expiryMonth, expiryYear, ccv, holderDocument } = card;
  if (!holderName || !number || !expiryMonth || !expiryYear || !ccv)
    throw Object.assign(new Error('Dados do cartão incompletos'), { status: 400 });

  const apiKey    = await getMainAsaasKey(db);
  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });
  const owner = ownerSnap.data();

  const cpf  = (holderDocument || owner.cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11) throw Object.assign(new Error('CPF do titular obrigatório'), { status: 400 });

  const customerId = await findOrCreateCustomer(owner.name, owner.email, cpf, owner.phone, apiKey);

  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate  = tomorrow.toISOString().slice(0, 10);

  const microAmount = parseFloat((1 + Math.random() * 8.99).toFixed(2));

  const microCharge = await asaasReq('POST', '/payments', {
    customer:    customerId,
    billingType: 'CREDIT_CARD',
    value:       microAmount,
    dueDate,
    description: 'Verificação de cartão iLocarPay',
    creditCard: {
      holderName,
      number:      number.replace(/\D/g, ''),
      expiryMonth: expiryMonth.padStart(2, '0'),
      expiryYear:  expiryYear.length === 2 ? `20${expiryYear}` : expiryYear,
      ccv
    },
    creditCardHolderInfo: {
      name:          holderName,
      email:         owner.email,
      cpfCnpj:       cpf,
      postalCode:    (owner.postalCode || '01310100').replace(/\D/g, ''),
      addressNumber: 'SN',
      phone:         (owner.phone || '11999999999').replace(/\D/g, '')
    }
  }, apiKey);

  const cardToken = microCharge.creditCard?.creditCardToken || null;
  const lastFour  = microCharge.creditCard?.creditCardNumber?.slice(-4) || '';
  const cardBrand = microCharge.creditCard?.creditCardBrand || '';
  const expMonth  = expiryMonth.padStart(2, '0');
  const expYear   = expiryYear.length === 2 ? `20${expiryYear}` : expiryYear;

  const verRef = db.collection('subscriptionVerifications').doc();
  const verData = {
    ownerId, plan,
    customerId,
    cardToken, lastFour, cardBrand,
    holderName, holderDocument: cpf,
    expiryMonth: expMonth, expiryYear: expYear,
    email:      owner.email,
    phone:      (owner.phone || '').replace(/\D/g, ''),
    postalCode: (owner.postalCode || '01310100').replace(/\D/g, ''),
    microAmount,
    microPaymentId: microCharge.id,
    realValue:  PLANS[plan].price,
    amountVerified: false,
    confirmed:      false,
    createdAt:  FieldValue.serverTimestamp(),
    expiresAt:  new Date(Date.now() + 30 * 60 * 1000)
  };
  if (!cardToken) verData.cardFallback = { holderName, number: number.replace(/\D/g, ''), expiryMonth: expMonth, expiryYear: expYear, ccv };

  await verRef.set(verData);
  return { verificationId: verRef.id, lastFour, cardBrand };
}

// ── CARD VERIFY ───────────────────────────────────────────────────────────────
async function handleCardVerify(db, body) {
  const { verificationId, userAmount } = body;
  if (!verificationId || userAmount == null) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const verRef  = db.collection('subscriptionVerifications').doc(verificationId);
  const verSnap = await verRef.get();
  if (!verSnap.exists) throw Object.assign(new Error('Verificação não encontrada'), { status: 404 });
  const ver = verSnap.data();

  if (ver.amountVerified) return { ok: true };

  const apiKey   = await getMainAsaasKey(db);
  const entered  = parseFloat(String(userAmount).replace(',', '.'));
  const expected = parseFloat(ver.microAmount);

  if (Math.abs(entered - expected) > 0.02) {
    await cancelOrRefund(ver.microPaymentId, apiKey);
    await verRef.update({ blocked: true });
    throw Object.assign(new Error('Valor incorreto. A cobrança de verificação foi estornada. Tente novamente.'), { status: 422 });
  }

  await Promise.all([
    cancelOrRefund(ver.microPaymentId, apiKey),
    verRef.update({ amountVerified: true })
  ]);
  return { ok: true, lastFour: ver.lastFour, cardBrand: ver.cardBrand };
}

// ── CARD CONFIRM ──────────────────────────────────────────────────────────────
async function handleCardConfirm(db, body) {
  const { verificationId } = body;
  if (!verificationId) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const verRef  = db.collection('subscriptionVerifications').doc(verificationId);
  const verSnap = await verRef.get();
  if (!verSnap.exists) throw Object.assign(new Error('Verificação não encontrada'), { status: 404 });
  const ver = verSnap.data();

  if (!ver.amountVerified) throw Object.assign(new Error('Cartão não verificado'), { status: 400 });
  if (ver.confirmed)       throw Object.assign(new Error('Pagamento já processado'), { status: 400 });

  const apiKey   = await getMainAsaasKey(db);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate  = tomorrow.toISOString().slice(0, 10);

  let realChargeBody;
  if (ver.cardToken) {
    realChargeBody = {
      customer:    ver.customerId, billingType: 'CREDIT_CARD',
      value:       ver.realValue, dueDate,
      description: `iLocarPay — Plano ${PLANS[ver.plan]?.name || ver.plan}`,
      creditCardToken: ver.cardToken,
      creditCardHolderInfo: {
        name: ver.holderName, email: ver.email, cpfCnpj: ver.holderDocument,
        postalCode: ver.postalCode, addressNumber: 'SN', phone: ver.phone || '11999999999'
      }
    };
  } else if (ver.cardFallback) {
    realChargeBody = {
      customer:    ver.customerId, billingType: 'CREDIT_CARD',
      value:       ver.realValue, dueDate,
      description: `iLocarPay — Plano ${PLANS[ver.plan]?.name || ver.plan}`,
      creditCard: {
        holderName: ver.holderName, number: ver.cardFallback.number,
        expiryMonth: ver.expiryMonth, expiryYear: ver.expiryYear, ccv: ver.cardFallback.ccv
      },
      creditCardHolderInfo: {
        name: ver.holderName, email: ver.email, cpfCnpj: ver.holderDocument,
        postalCode: ver.postalCode, addressNumber: 'SN', phone: ver.phone || '11999999999'
      }
    };
  } else {
    throw Object.assign(new Error('Dados do cartão indisponíveis'), { status: 400 });
  }

  await asaasReq('POST', '/payments', realChargeBody, apiKey);
  await Promise.all([
    activatePlan(db, ver.ownerId, ver.plan),
    verRef.update({ confirmed: true, paidAt: FieldValue.serverTimestamp() })
  ]);

  return { paid: true, plan: ver.plan, planName: PLANS[ver.plan]?.name || ver.plan };
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    initFirebase();
    const db   = getFirestore();
    const { step } = req.body || {};
    let result;
    if      (step === 'pix')          result = await handlePix(db, req.body);
    else if (step === 'check-pix')    result = await handleCheckPix(db, req.body);
    else if (step === 'card-init')    result = await handleCardInit(db, req.body);
    else if (step === 'card-verify')  result = await handleCardVerify(db, req.body);
    else if (step === 'card-confirm') result = await handleCardConfirm(db, req.body);
    else throw Object.assign(new Error('step inválido'), { status: 400 });
    res.status(200).json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}
