// POST /api/locarpay-card
// { tenantId, chargeId, card: { holderName, number, expiryMonth, expiryYear, ccv, postalCode, addressNumber } }

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

async function asaasPost(path, body, apiKey) {
  const r = await fetch(`https://api.asaas.com/v3${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas ${path} ${r.status}: ${JSON.stringify(json)}`);
  return json;
}

async function findOrCreateCustomer(name, email, cpf, apiKey) {
  const search = await fetch(
    `https://api.asaas.com/v3/customers?email=${encodeURIComponent(email)}&limit=1`,
    { headers: { 'access_token': apiKey } }
  );
  const searchJson = await search.json();
  if (searchJson.data?.length > 0) return searchJson.data[0].id;

  const cpfDigits = (cpf || '').replace(/\D/g, '');
  const body = { name: name || email.split('@')[0], email };
  if (cpfDigits.length === 11) body.cpfCnpj = cpfDigits;
  const customer = await asaasPost('/customers', body, apiKey);
  return customer.id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();

    const { tenantId, chargeId, card } = req.body || {};
    if (!tenantId || !chargeId || !card)
      return res.status(400).json({ error: 'tenantId, chargeId e card são obrigatórios' });

    const { holderName, number, expiryMonth, expiryYear, ccv, postalCode, addressNumber } = card;
    if (!holderName || !number || !expiryMonth || !expiryYear || !ccv)
      return res.status(400).json({ error: 'Dados do cartão incompletos' });

    const [userSnap, chargeSnap, configSnap] = await Promise.all([
      db.collection('users').doc(tenantId).get(),
      db.collection('charges').doc(chargeId).get(),
      db.collection('config').doc('asaas').get()
    ]);

    if (!userSnap.exists)   return res.status(404).json({ error: 'Inquilino não encontrado' });
    if (!chargeSnap.exists) return res.status(404).json({ error: 'Cobrança não encontrada' });

    const apiKey = configSnap.data()?.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'Chave Asaas não configurada' });

    const user   = userSnap.data();
    const charge = chargeSnap.data();

    const name  = user.name  || user.email?.split('@')[0] || 'Inquilino';
    const email = user.email || '';
    const cpf   = user.cpf   || '';
    const phone = (user.phone || '').replace(/\D/g, '');

    const customerId = await findOrCreateCustomer(name, email, cpf, apiKey);

    // DueDate: amanhã no mínimo
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dueDate = tomorrow.toISOString().slice(0, 10);

    const value = charge.totalAmount || charge.baseRent || 5;

    const chargeBody = {
      customer:    customerId,
      billingType: 'CREDIT_CARD',
      value,
      dueDate,
      description: `Aluguel ${dueDate.slice(0, 7)}`,
      creditCard: {
        holderName,
        number:      number.replace(/\D/g, ''),
        expiryMonth: expiryMonth.padStart(2, '0'),
        expiryYear:  expiryYear.length === 2 ? `20${expiryYear}` : expiryYear,
        ccv
      },
      creditCardHolderInfo: {
        name:  holderName,
        email,
        cpfCnpj:       cpf.replace(/\D/g, '') || '00000000000',
        postalCode:    (postalCode || '').replace(/\D/g, '') || '00000000',
        addressNumber: addressNumber || 'S/N',
        phone:         phone || '00000000000'
      }
    };

    const asaasCharge = await asaasPost('/payments', chargeBody, apiKey);

    // Marca como pago se aprovado
    const paid = asaasCharge.status === 'CONFIRMED' || asaasCharge.status === 'RECEIVED';
    await db.collection('charges').doc(chargeId).update({
      asaasChargeId:   asaasCharge.id,
      status:          paid ? 'paid' : 'under_review',
      ...(paid ? { paidAt: new Date() } : {})
    });

    return res.status(200).json({
      status:  asaasCharge.status,
      paid,
      message: paid ? 'Pagamento aprovado!' : 'Pagamento em análise.'
    });

  } catch (e) {
    console.error('locarpay-card error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
