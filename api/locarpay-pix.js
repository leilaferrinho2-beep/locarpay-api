// POST /api/locarpay-pix
// { tenantId, chargeId }
// Lê CPF/nome do Firestore, cria cliente+cobrança no Asaas, salva QR no Firestore

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getAsaasKey, getDefaultOwnerId, checkOwnerPlanActive } from '../lib/owner.js';

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

    const { tenantId, chargeId, checkOnly } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatório' });

    // Lê dados do Firestore
    const [userSnap, chargeSnap] = await Promise.all([
      db.collection('users').doc(tenantId).get(),
      chargeId ? db.collection('charges').doc(chargeId).get() : Promise.resolve({ exists: false }),
    ]);

    if (!userSnap.exists) return res.status(404).json({ error: 'Inquilino não encontrado' });

    // Resolve owner: usa ownerId da cobrança ou fallback para o primeiro owner
    const ownerId = chargeSnap.exists
      ? (chargeSnap.data().ownerId || await getDefaultOwnerId(db))
      : await getDefaultOwnerId(db);

    // Verifica plano ativo
    const planCheck = await checkOwnerPlanActive(db, ownerId);
    if (!planCheck.active) {
      return res.status(402).json({
        error: 'Plano expirado. Acesse o painel LocarPay para renovar a assinatura.',
        reason: planCheck.reason
      });
    }

    // Validação cruzada: inquilino deve pertencer ao mesmo owner da cobrança
    const userOwnerId = userSnap.data().ownerId;
    if (userOwnerId && ownerId && userOwnerId !== ownerId) {
      return res.status(403).json({ error: 'Acesso negado: cobrança não pertence a este inquilino' });
    }

    const [apiKey, configSnap] = await Promise.all([
      getAsaasKey(db, ownerId),
      db.collection('owners').doc(ownerId).get(),
    ]);
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

    // Se já está pago no Firestore, retorna imediatamente
    if (charge.status === 'paid') {
      return res.status(200).json({ paid: true });
    }

    // Se tem asaasChargeId, verifica status no Asaas antes de tentar criar novo
    if (charge.asaasChargeId) {
      try {
        const statusRes = await fetch(`https://api.asaas.com/v3/payments/${charge.asaasChargeId}`, {
          headers: { 'access_token': apiKey }
        });
        if (statusRes.ok) {
          const asaasData = await statusRes.json();
          if (asaasData.status === 'RECEIVED' || asaasData.status === 'CONFIRMED') {
            // Pago no Asaas mas não no Firestore (webhook falhou): sincroniza agora
            await db.collection('charges').doc(resolvedChargeId).update({ status: 'paid' });
            return res.status(200).json({ paid: true });
          }
        }
      } catch (_) {}
    }

    // checkOnly=true: só verificou status, não precisa gerar novo QR
    if (checkOnly) {
      return res.status(200).json({ paid: false, status: charge.status });
    }

    const name  = user.name  || user.email?.split('@')[0] || 'Inquilino';
    const email = user.email || '';
    const cpf   = user.cpf   || '';
    const phone = user.phone || '';

    // Data de hoje (meia-noite horário Brasil UTC-3)
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    nowBR.setHours(0, 0, 0, 0);
    const todayStr = nowBR.toISOString().slice(0, 10); // YYYY-MM-DD

    const chargeDueDate = charge.dueDate?.seconds
      ? new Date(charge.dueDate.seconds * 1000)
      : null;

    // Dias de atraso (0 = ainda no prazo)
    let daysOverdue = 0;
    if (chargeDueDate) {
      const dueMidnight = new Date(chargeDueDate); dueMidnight.setHours(0, 0, 0, 0);
      daysOverdue = Math.max(0, Math.floor((nowBR - dueMidnight) / 86400000));
    }
    const isOverdue = daysOverdue > 0;

    // Se não está vencida e o QR foi gerado hoje, retorna direto
    const pixDate = charge.pixGeneratedDate; // YYYY-MM-DD
    if (!isOverdue && charge.pixCopyPaste && charge.pixQrCode) {
      return res.status(200).json({ pixCopyPaste: charge.pixCopyPaste, pixQrCode: charge.pixQrCode });
    }

    // Se está vencida mas o QR já foi gerado HOJE, retorna o QR atual (já tem os juros do dia)
    if (isOverdue && pixDate === todayStr && charge.pixCopyPaste && charge.pixQrCode) {
      return res.status(200).json({ pixCopyPaste: charge.pixCopyPaste, pixQrCode: charge.pixQrCode });
    }

    // QR precisa ser (re)criado: cobrança nova OU vencida com QR de outro dia → cancela o antigo
    if (charge.asaasChargeId) {
      try {
        await fetch(`https://api.asaas.com/v3/payments/${charge.asaasChargeId}`, {
          method: 'DELETE',
          headers: { 'access_token': apiKey }
        });
      } catch (_) {}
      await db.collection('charges').doc(resolvedChargeId).update({
        asaasChargeId: null, pixCopyPaste: null, pixQrCode: null, pixGeneratedDate: null
      });
    }

    // Se não está vencida e tem asaasChargeId (cancelado acima não entra aqui), fallback
    // — cria cliente e segue normalmente
    const customerId = await findOrCreateCustomer(name, email, cpf, phone, apiKey);

    // DueDate para o Asaas:
    //  - Se vencido: hoje (valor já inclui multa+juros calculados manualmente; Asaas aceita hoje)
    //  - Se no prazo: data original da cobrança
    let dueDate;
    if (isOverdue) {
      dueDate = todayStr;
    } else if (chargeDueDate) {
      dueDate = chargeDueDate.toISOString().slice(0, 10);
    } else {
      const tomorrow = new Date(nowBR); tomorrow.setDate(tomorrow.getDate() + 1);
      dueDate = tomorrow.toISOString().slice(0, 10);
    }

    const baseValue = charge.baseRent || charge.totalAmount || 5;

    // Configurações de atraso (lidas do Firestore ou padrão)
    const configData = (configSnap.exists ? configSnap.data() : {}) || {};
    const finePercentage         = configData.finePercentage          ?? 2;    // % multa única
    const interestRate           = configData.interestRate             ?? 1;    // % a.m. juros mora
    const monetaryCorrectionRate = configData.monetaryCorrectionRate   ?? 0.35; // % a.m. IPCA-E
    const cardFeePercentage      = configData.cardFeePercentage        ?? 2.99;

    // Para cobranças vencidas: calcula multa+juros manualmente e embute no valor.
    // O Asaas recebe dueDate=hoje, então fine/interest params só ativariam amanhã —
    // embutindo no valor garantimos o total correto imediatamente.
    let value;
    let paymentFine     = null;
    let paymentInterest = null;
    if (isOverdue) {
      const fineAmount     = baseValue * finePercentage / 100;
      const dailyRate      = (interestRate + monetaryCorrectionRate) / 100 / 30;
      const interestAmount = baseValue * dailyRate * daysOverdue;
      value = Math.round((baseValue + fineAmount + interestAmount) * 100) / 100;
    } else {
      value           = baseValue;
      paymentFine     = { value: finePercentage };
      paymentInterest = { value: parseFloat((interestRate + monetaryCorrectionRate).toFixed(4)) };
    }
    const description = `Aluguel ${chargeDueDate ? chargeDueDate.toISOString().slice(0,7) : dueDate.slice(0,7)}`;

    // Lê walletId master e percentual de comissão para split automático
    let splitEntry = null;
    try {
      const configAsaas = await db.collection('config').doc('asaas').get();
      const masterWalletId = configAsaas.data()?.walletId || process.env.ASAAS_MASTER_WALLET_ID;
      const commissionPct  = configData.commissionPercentage ?? configAsaas.data()?.commissionPercentage ?? 1;
      if (masterWalletId) splitEntry = { walletId: masterWalletId, percentualValor: commissionPct };
    } catch (_) {}

    // Cria cobrança PIX no Asaas:
    //  - fine + interest configurados: Asaas aplica automaticamente após vencimento (PIX dinâmico)
    //  - dueDate=hoje para vencidos: Asaas aceita hoje e contabiliza atraso a partir de amanhã
    const paymentBody = {
      customer:    customerId,
      billingType: 'PIX',
      value,
      dueDate,
      description,
    };
    if (paymentFine)     paymentBody.fine     = paymentFine;
    if (paymentInterest) paymentBody.interest = paymentInterest;
    if (splitEntry) paymentBody.split = [splitEntry];

    const asaasCharge = await asaasPost('/payments', paymentBody, apiKey);

    // Busca QR Code
    const pix = await asaasGet(`/payments/${asaasCharge.id}/pixQrCode`, apiKey);

    // Salva no Firestore com a data de geração para controle de renovação diária
    await db.collection('charges').doc(resolvedChargeId).update({
      asaasChargeId:    asaasCharge.id,
      pixCopyPaste:     pix.payload,
      pixQrCode:        pix.encodedImage,
      pixGeneratedDate: todayStr,       // YYYY-MM-DD — renova após meia-noite
      pixTotalValue:    value           // valor exato cobrado (base + multa + juros)
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
