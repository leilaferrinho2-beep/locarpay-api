// POST /api/ilocarpay-pix
// { tenantId, chargeId }
// Lê CPF/nome do Firestore, cria cliente+cobrança no Asaas, salva QR no Firestore

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getAsaasKey, getDefaultOwnerId, checkOwnerPlanActive } from '../lib/owner.js';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

const ASAAS_BASE = (process.env.ASAAS_API_URL || 'https://api.asaas.com/v3').replace(/\/$/, '');

async function asaasPost(path, body, apiKey) {
  const r = await fetch(`${ASAAS_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Asaas ${path} ${r.status}: ${JSON.stringify(json)}`);
  return json;
}

async function asaasGet(path, apiKey) {
  const r = await fetch(`${ASAAS_BASE}${path}`, {
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
    `${ASAAS_BASE}/customers?email=${encodeURIComponent(email)}&limit=1`,
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
      await fetch(`${ASAAS_BASE}/customers/${existing.id}`, {
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

// Gera um PIX combinado para múltiplas cobranças selecionadas pelo inquilino.
// Salva asaasChargeId + linkedChargeIds na primeira cobrança (primária).
// O webhook e o polling marcam TODAS as cobranças como pagas ao confirmar.
async function handleMultiChargePix(db, req, res, tenantId, chargeIds, checkOnly) {
  try {
    const userSnap = await db.collection('users').doc(tenantId).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'Inquilino não encontrado' });

    // Carrega todas as cobranças
    const chargeSnaps = await Promise.all(chargeIds.map(id => db.collection('charges').doc(id).get()));
    const valid = chargeSnaps.filter(s => s.exists && ['pending','overdue'].includes(s.data().status));
    if (!valid.length) return res.status(404).json({ error: 'Nenhuma cobrança válida encontrada' });

    // Se todas já pagas, retorna paid
    if (valid.every(s => s.data().status === 'paid')) return res.status(200).json({ paid: true });

    const primarySnap = valid[0];
    const primaryId   = primarySnap.id;
    const primaryData = primarySnap.data();
    const ownerId     = primaryData.ownerId || await getDefaultOwnerId(db);

    // checkOnly: checa status do PIX primário
    if (checkOnly) {
      if (primaryData.asaasChargeId) {
        try {
          const s = await fetch(`${ASAAS_BASE}/payments/${primaryData.asaasChargeId}`, {
            headers: { 'access_token': await getAsaasKey(db, ownerId) }
          });
          const d = await s.json();
          if (d.status === 'RECEIVED' || d.status === 'CONFIRMED') {
            const batch = db.batch();
            valid.forEach(snap => batch.update(snap.ref, { status: 'paid', paidAt: new Date() }));
            await batch.commit();
            return res.status(200).json({ paid: true });
          }
        } catch (_) {}
      }
      return res.status(200).json({ paid: false });
    }

    const planCheck = await checkOwnerPlanActive(db, ownerId);
    if (!planCheck.active) return res.status(402).json({ error: 'Plano expirado' });

    const [apiKey, ownerSnap] = await Promise.all([
      getAsaasKey(db, ownerId),
      db.collection('owners').doc(ownerId).get()
    ]);
    if (!apiKey) return res.status(500).json({ error: 'Chave Asaas não configurada' });

    const ownerCfg = ownerSnap.exists ? (ownerSnap.data() || {}) : {};
    const finePercentage         = ownerCfg.finePercentage          ?? 2;
    const interestRate           = ownerCfg.interestRate             ?? 1;
    const monetaryCorrectionRate = ownerCfg.monetaryCorrectionRate   ?? 0.35;
    const user = userSnap.data();

    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    nowBR.setHours(0, 0, 0, 0);
    const todayStr = nowBR.toISOString().slice(0, 10);

    // Se QR combinado já gerado hoje, retorna direto
    if (primaryData.asaasChargeId && primaryData.pixCopyPaste && primaryData.pixQrCode
        && primaryData.pixGeneratedDate === todayStr
        && JSON.stringify((primaryData.linkedChargeIds || []).sort()) === JSON.stringify([...chargeIds].sort())) {
      return res.status(200).json({ pixCopyPaste: primaryData.pixCopyPaste, pixQrCode: primaryData.pixQrCode });
    }

    // Cancela QR anterior se existir
    if (primaryData.asaasChargeId) {
      try {
        await fetch(`${ASAAS_BASE}/payments/${primaryData.asaasChargeId}`, {
          method: 'DELETE', headers: { 'access_token': apiKey }
        });
      } catch (_) {}
      await db.collection('charges').doc(primaryId).update({
        asaasChargeId: null, pixCopyPaste: null, pixQrCode: null, pixGeneratedDate: null
      });
    }

    // Calcula valor total combinado com multa/juros
    let totalValue = 0;
    for (const snap of valid) {
      const c = snap.data();
      const baseVal = c.baseRent || c.totalAmount || 0;
      const dueDate = c.dueDate?.seconds ? new Date(c.dueDate.seconds * 1000) : null;
      const dueMid = dueDate ? new Date(dueDate.setHours(0,0,0,0)) : nowBR;
      const days = Math.max(0, Math.floor((nowBR - dueMid) / 86400000));
      if (days > 0) {
        const fine     = baseVal * finePercentage / 100;
        const interest = baseVal * (interestRate + monetaryCorrectionRate) / 100 / 30 * days;
        totalValue += Math.round((baseVal + fine + interest) * 100) / 100;
      } else {
        totalValue += baseVal;
      }
    }
    totalValue = Math.round(totalValue * 100) / 100;

    const customerId = await findOrCreateCustomer(
      user.name || user.email?.split('@')[0] || 'Inquilino',
      user.email || '', user.cpf || '', user.phone || '', apiKey
    );

    // Split de comissão
    let splitEntry = null;
    try {
      const cfgAsaas = await db.collection('config').doc('asaas').get();
      const masterWalletId = cfgAsaas.data()?.walletId || process.env.ASAAS_MASTER_WALLET_ID;
      const commPct = ownerCfg.commissionPercentage ?? cfgAsaas.data()?.commissionPercentage ?? 1;
      if (masterWalletId) splitEntry = { walletId: masterWalletId, percentualValor: commPct };
    } catch (_) {}

    const paymentBody = {
      customer: customerId,
      billingType: 'PIX',
      value: totalValue,
      dueDate: todayStr,
      description: `Pagamento combinado — ${valid.length} cobranças`
    };
    if (splitEntry) paymentBody.split = [splitEntry];

    const asaasCharge = await asaasPost('/payments', paymentBody, apiKey);
    const pix         = await asaasGet(`/payments/${asaasCharge.id}/pixQrCode`, apiKey);

    await db.collection('charges').doc(primaryId).update({
      asaasChargeId:    asaasCharge.id,
      pixCopyPaste:     pix.payload,
      pixQrCode:        pix.encodedImage,
      pixGeneratedDate: todayStr,
      pixTotalValue:    totalValue,
      linkedChargeIds:  chargeIds   // todos os IDs para marcar como pago no webhook
    });

    return res.status(200).json({ pixCopyPaste: pix.payload, pixQrCode: pix.encodedImage });
  } catch (e) {
    console.error('handleMultiChargePix error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();

    const { tenantId, chargeId, chargeIds, checkOnly } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatório' });

    // ── Multi-charge: chargeIds[] enviado pelo app para PIX combinado ─────
    const isMulti = Array.isArray(chargeIds) && chargeIds.length > 1;
    if (isMulti) {
      return handleMultiChargePix(db, req, res, tenantId, chargeIds, checkOnly);
    }

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
        error: 'Plano expirado. Acesse o painel iLocarPay para renovar a assinatura.',
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
        const statusRes = await fetch(`${ASAAS_BASE}/payments/${charge.asaasChargeId}`, {
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
        await fetch(`${ASAAS_BASE}/payments/${charge.asaasChargeId}`, {
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
    console.error('ilocarpay-pix error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
