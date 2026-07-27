// POST /api/locarpay-pix
// { tenantId, chargeId }
// Lê CPF/nome do Firestore, cria cliente+cobrança no Asaas, salva QR no Firestore

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

async function asaasGet(path, apiKey) {
  const r = await fetch(`https://api.asaas.com/v3${path}`, {
    headers: { 'access_token': apiKey }
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
  const searchJson = await search.json();
  if (searchJson.data?.length > 0) {
    const existing = searchJson.data[0];
    const needsUpdate = (!existing.cpfCnpj && cpfDigits.length === 11)
                     || (!existing.mobilePhone && phoneDigits.length >= 10);
    if (needsUpdate) {
      const patch = { name: existing.name };
      if (!existing.cpfCnpj    && cpfDigits.length === 11)   patch.cpfCnpj     = cpfDigits;
      if (!existing.mobilePhone && phoneDigits.length >= 10) patch.mobilePhone  = phoneDigits;
      await fetch(`https://api.asaas.com/v3/customers/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
        body: JSON.stringify(patch)
      });
    }
    if (!existing.cpfCnpj && cpfDigits.length !== 11) {
      throw new Error('CPF do inquilino não cadastrado. Peça ao administrador para atualizar o cadastro.');
    }
    return existing.id;
  }

  const body = { name: name || email.split('@')[0], email };
  if (cpfDigits.length === 11)  body.cpfCnpj    = cpfDigits;
  if (phoneDigits.length >= 10) body.mobilePhone = phoneDigits;
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

    const { tenantId, chargeId } = req.body || {};
    if (!tenantId || !chargeId) return res.status(400).json({ error: 'tenantId e chargeId obrigatórios' });

    // Lê dados do Firestore
    const [userSnap, chargeSnap, configSnap] = await Promise.all([
      db.collection('users').doc(tenantId).get(),
      db.collection('charges').doc(chargeId).get(),
      db.collection('config').doc('asaas').get()
    ]);

    if (!userSnap.exists) return res.status(404).json({ error: 'Inquilino não encontrado' });

    const apiKey = configSnap.data()?.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'Chave Asaas não configurada' });

    const user = userSnap.data();

    // Se chargeId não existe, busca cobrança pendente do inquilino pelo tenantId
    let charge, resolvedChargeId;
    if (chargeSnap.exists) {
      charge = chargeSnap.data();
      resolvedChargeId = chargeId;
    } else {
      const fallbackSnap = await db.collection('charges')
        .where('tenantId', '==', tenantId)
        .where('status', 'in', ['pending', 'overdue'])
        .orderBy('dueDate', 'desc')
        .limit(1)
        .get();
      if (fallbackSnap.empty) {
        // Tenta por email como último recurso
        const emailFallback = await db.collection('charges')
          .where('tenantEmail', '==', user.email || '')
          .where('status', 'in', ['pending', 'overdue'])
          .orderBy('dueDate', 'desc')
          .limit(1)
          .get();
        if (emailFallback.empty) return res.status(404).json({ error: 'Cobrança não encontrada' });
        charge = emailFallback.docs[0].data();
        resolvedChargeId = emailFallback.docs[0].id;
      } else {
        charge = fallbackSnap.docs[0].data();
        resolvedChargeId = fallbackSnap.docs[0].id;
      }
    }

    // Se já tem PIX salvo, retorna direto
    if (charge.pixCopyPaste && charge.pixQrCode) {
      return res.status(200).json({
        pixCopyPaste: charge.pixCopyPaste,
        pixQrCode:    charge.pixQrCode
      });
    }

    const name  = user.name  || user.email?.split('@')[0] || 'Inquilino';
    const email = user.email || '';
    const cpf   = user.cpf   || '';
    const phone = user.phone || '';

    // Se já tem asaasChargeId, tenta só buscar o QR
    if (charge.asaasChargeId) {
      try {
        const pix = await asaasGet(`/payments/${charge.asaasChargeId}/pixQrCode`, apiKey);
        await db.collection('charges').doc(resolvedChargeId).update({
          pixCopyPaste: pix.payload,
          pixQrCode:    pix.encodedImage
        });
        return res.status(200).json({ pixCopyPaste: pix.payload, pixQrCode: pix.encodedImage });
      } catch (_) { /* segue para criar nova cobrança */ }
    }

    // Cria ou reutiliza cliente no Asaas
    const customerId = await findOrCreateCustomer(name, email, cpf, phone, apiKey);

    // DueDate: usa a data da cobrança, mas garante que seja >= amanhã se já venceu
    let dueDate;
    if (charge.dueDate?.seconds) {
      const d = new Date(charge.dueDate.seconds * 1000);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (d < today) {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        dueDate = tomorrow.toISOString().slice(0, 10);
      } else {
        dueDate = d.toISOString().slice(0, 10);
      }
    } else {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      dueDate = tomorrow.toISOString().slice(0, 10);
    }

    const value = charge.totalAmount || charge.baseRent || 5;

    // Configurações de atraso (lidas do Firestore ou padrão)
    const configData = configSnap.data() || {};
    const finePercentage    = configData.finePercentage    ?? 2;    // multa 2% padrão
    const interestRate      = configData.interestRate      ?? 1;    // juros 1%/mês padrão
    const cardFeePercentage = configData.cardFeePercentage ?? 2.99; // taxa cartão 2.99%

    // Cria cobrança PIX no Asaas com configuração de juros/multa
    const asaasCharge = await asaasPost('/payments', {
      customer:    customerId,
      billingType: 'PIX',
      value,
      dueDate,
      description: `Aluguel ${dueDate.slice(0, 7)}`,
      fine:     { value: finePercentage },
      interest: { value: interestRate }
    }, apiKey);

    // Busca QR Code
    const pix = await asaasGet(`/payments/${asaasCharge.id}/pixQrCode`, apiKey);

    // Salva no Firestore
    await db.collection('charges').doc(resolvedChargeId).update({
      asaasChargeId: asaasCharge.id,
      pixCopyPaste:  pix.payload,
      pixQrCode:     pix.encodedImage
    });

    return res.status(200).json({
      pixCopyPaste: pix.payload,
      pixQrCode:    pix.encodedImage
    });

  } catch (e) {
    console.error('locarpay-pix error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
