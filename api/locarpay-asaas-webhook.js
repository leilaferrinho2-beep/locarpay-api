// POST /api/locarpay-asaas-webhook
// Recebe eventos do Asaas (pagamento confirmado, vencido, etc.)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

async function sendWhatsApp(phone, text) {
  const url  = process.env.EVOLUTION_API_URL;
  const key  = process.env.EVOLUTION_API_KEY;
  const inst = process.env.EVOLUTION_INSTANCE;
  if (!url || !key || !inst || !phone) return;
  const number = phone.replace(/\D/g, '');
  if (number.length < 10) return;
  try {
    await fetch(`${url}/message/sendText/${inst}`, {
      method: 'POST',
      headers: { 'apikey': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, text })
    });
  } catch (e) {
    console.warn('[whatsapp] falha ao enviar:', e.message);
  }
}

function formatBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${months[parseInt(m) - 1]}/${y}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'locarpay-asaas-webhook' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};
  const event   = (payload.event || '').toUpperCase();
  const payment = payload.payment || {};

  console.log('[asaas-webhook] event:', event, 'paymentId:', payment.id);

  const PAYMENT_EVENTS = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];
  if (!PAYMENT_EVENTS.includes(event)) {
    return res.status(200).json({ ok: true, skipped: `evento '${event}' não mapeado` });
  }

  const asaasChargeId = payment.id;
  if (!asaasChargeId) {
    return res.status(200).json({ ok: true, skipped: 'payment.id ausente' });
  }

  try {
    initFirebase();
    const db = getFirestore();

    // Busca a cobrança pelo asaasChargeId
    const chargeSnap = await db.collection('charges')
      .where('asaasChargeId', '==', asaasChargeId)
      .limit(1)
      .get();

    if (chargeSnap.empty) {
      console.warn('[asaas-webhook] cobrança não encontrada para', asaasChargeId);
      return res.status(200).json({ ok: true, skipped: 'cobrança não encontrada' });
    }

    const chargeRef  = chargeSnap.docs[0].ref;
    const chargeId   = chargeSnap.docs[0].id;
    const charge     = chargeSnap.docs[0].data();

    // Evita processar duas vezes
    if (charge.status === 'paid') {
      return res.status(200).json({ ok: true, skipped: 'já estava pago' });
    }

    // Atualiza status da cobrança
    await chargeRef.update({
      status:   'paid',
      paidAt:   FieldValue.serverTimestamp(),
      paidValue: payment.value || charge.totalAmount
    });

    console.log(`[asaas-webhook] cobrança ${chargeId} marcada como paga`);

    // Busca dados do inquilino, proprietário e corretor
    const [tenantSnap, contractSnap] = await Promise.all([
      charge.tenantId ? db.collection('users').doc(charge.tenantId).get() : Promise.resolve(null),
      charge.contractId ? db.collection('contracts').doc(charge.contractId).get() : Promise.resolve(null)
    ]);

    const tenant   = tenantSnap?.data()   || {};
    const contract = contractSnap?.data() || {};

    const tenantName   = tenant.name      || charge.tenantName  || 'Inquilino';
    const endereco     = contract.address || charge.address     || charge.description || 'o imóvel';
    const valor        = formatBRL(payment.value || charge.totalAmount);
    const periodo      = formatDate(payment.dueDate || charge.dueDate?.toDate?.()?.toISOString()?.slice(0, 10));

    const tenantPhone   = tenant.phone          || charge.tenantPhone    || null;
    const landlordPhone = contract.landlordPhone || charge.landlordPhone  || null;
    const brokerPhone   = contract.brokerPhone   || charge.brokerPhone
                       || contract.corretorPhone || charge.corretorPhone  || null;

    // Mensagem para o inquilino
    const msgTenant = `✅ *iLocarPay* — Pagamento confirmado!\n\nRecebemos seu pagamento de *${valor}* referente ao aluguel de *${periodo}* do imóvel ${endereco}.\n\nObrigado! 🏠`;

    // Mensagem para o proprietário
    const msgOwner = `💰 *iLocarPay* — Aluguel recebido!\n\nO inquilino *${tenantName}* realizou o pagamento de *${valor}* ref. ${periodo} — imóvel: ${endereco}.\n\nO repasse será processado em até 2 dias úteis.`;

    // Mensagem para o corretor/imobiliária
    const msgBroker = `📋 *iLocarPay* — Pagamento confirmado\n\n*Inquilino:* ${tenantName}\n*Valor:* ${valor}\n*Período:* ${periodo}\n*Imóvel:* ${endereco}\n\nCobrança ID: ${chargeId}`;

    await Promise.all([
      sendWhatsApp(tenantPhone,   msgTenant),
      sendWhatsApp(landlordPhone, msgOwner),
      sendWhatsApp(brokerPhone,   msgBroker)
    ]);

    console.log(`[asaas-webhook] WhatsApp enviado — inquilino:${tenantPhone} proprietário:${landlordPhone} corretor:${brokerPhone}`);

    return res.status(200).json({ ok: true, chargeId, paidValue: payment.value });

  } catch (e) {
    console.error('[asaas-webhook] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
