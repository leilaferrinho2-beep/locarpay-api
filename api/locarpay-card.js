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

async function findOrCreateCustomer(name, email, cpf, apiKey) {
  const cpfDigits = (cpf || '').replace(/\D/g, '');
  const search = await fetch(
    `https://api.asaas.com/v3/customers?email=${encodeURIComponent(email)}&limit=1`,
    { headers: { 'access_token': apiKey } }
  );
  const { data } = await search.json();
  if (data?.length > 0) {
    const existing = data[0];
    if (!existing.cpfCnpj && cpfDigits.length === 11) {
      await fetch(`https://api.asaas.com/v3/customers/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
        body: JSON.stringify({ name: existing.name, cpfCnpj: cpfDigits })
      });
    }
    return existing.id;
  }
  const body = { name: name || email.split('@')[0], email };
  if (cpfDigits.length === 11) body.cpfCnpj = cpfDigits;
  const c = await asaasReq('POST', '/customers', body, apiKey);
  return c.id;
}

// ── INIT ────────────────────────────────────────────────────────────────────
async function handleInit(db, body, apiKey) {
  const { tenantId, chargeId, card } = body;
  if (!tenantId || !chargeId || !card)
    throw Object.assign(new Error('tenantId, chargeId e card obrigatórios'), { status: 400 });

  const { holderName, number, expiryMonth, expiryYear, ccv, postalCode, addressNumber } = card;
  if (!holderName || !number || !expiryMonth || !expiryYear || !ccv)
    throw Object.assign(new Error('Dados do cartão incompletos'), { status: 400 });

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

  const customerId = await findOrCreateCustomer(name, email, cpf, apiKey);

  // Valor aleatório entre R$1,01 e R$4,99 com centavos aleatórios
  const microValue = parseFloat((1 + Math.random() * 3.98).toFixed(2));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = tomorrow.toISOString().slice(0, 10);

  const chargeBody = {
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
    creditCardHolderInfo: {
      name:          holderName,
      email,
      cpfCnpj:       cpf,
      postalCode:    (postalCode || '').replace(/\D/g, '') || '00000000',
      addressNumber: addressNumber || 'SN',
      phone:         phone || '11999999999'
    }
  };

  const asaasCharge = await asaasReq('POST', '/payments', chargeBody, apiKey);
  const cardToken   = asaasCharge.creditCard?.creditCardToken || null;

  // Salva no Firestore — valor NUNCA sai para o cliente
  const verRef = db.collection('cardVerifications').doc();
  await verRef.set({
    tenantId,
    chargeId,
    customerId,
    expectedAmount:   microValue,
    cardToken,
    asaasVerifyId:    asaasCharge.id,
    holderName,
    expiryMonth:      expiryMonth.padStart(2, '0'),
    expiryYear:       expiryYear.length === 2 ? `20${expiryYear}` : expiryYear,
    ccv,
    postalCode:       (postalCode || '').replace(/\D/g, ''),
    addressNumber:    addressNumber || 'SN',
    attempts:         0,
    verified:         false,
    createdAt:        FieldValue.serverTimestamp(),
    expiresAt:        new Date(Date.now() + 24 * 60 * 60 * 1000)
  });

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

  // Valor correto — estorna o micro-cobro
  try {
    await asaasReq('POST', `/payments/${ver.asaasVerifyId}/refunds`, {}, apiKey);
  } catch (_) { /* estorno falhou mas seguimos */ }

  // Cobra o aluguel real
  const chargeSnap = await db.collection('charges').doc(ver.chargeId).get();
  const charge     = chargeSnap.data();
  const value      = charge.totalAmount || charge.baseRent || 5;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate  = tomorrow.toISOString().slice(0, 10);

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
        cpfCnpj: (charge.tenantCpf || '').replace(/\D/g, '') || (await db.collection('users').doc(ver.tenantId).get()).data()?.cpf?.replace(/\D/g, '') || ''
      }
    }, apiKey);
  } else {
    throw new Error('Token do cartão não disponível. Tente novamente.');
  }

  const paid = ['CONFIRMED','RECEIVED'].includes(asaasRealCharge.status);
  await Promise.all([
    db.collection('charges').doc(ver.chargeId).update({
      asaasChargeId: asaasRealCharge.id,
      status:        paid ? 'paid' : 'under_review',
      ...(paid ? { paidAt: FieldValue.serverTimestamp() } : {})
    }),
    verRef.update({ verified: true, paidAt: FieldValue.serverTimestamp() })
  ]);

  return { paid, status: asaasRealCharge.status, message: paid ? 'Pagamento aprovado!' : 'Pagamento em análise.' };
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

    if (step === 'init') {
      const result = await handleInit(db, req.body, apiKey);
      return res.status(200).json(result);
    }
    if (step === 'confirm') {
      const result = await handleConfirm(db, req.body, apiKey);
      return res.status(200).json(result);
    }
    return res.status(400).json({ error: 'step deve ser "init" ou "confirm"' });

  } catch (e) {
    console.error('locarpay-card error:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
