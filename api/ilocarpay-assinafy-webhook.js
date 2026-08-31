// POST /api/ilocarpay-assinafy-webhook
// Recebe eventos da Assinafy quando um signatário assina ou o documento é concluído.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const ASSINAFY   = 'https://api.assinafy.com.br/v1';
const FB_PROJECT = 'locarpayapp';
const BUCKET     = `${FB_PROJECT}.appspot.com`;

async function sendWhatsApp(phone, text) {
  const url  = process.env.EVOLUTION_API_URL;
  const key  = process.env.EVOLUTION_API_KEY;
  const inst = process.env.EVOLUTION_INSTANCE;
  if (!url || !key || !inst || !phone) return;
  const number = phone.replace(/\D/g, '');
  if (number.length < 10) return;
  try {
    await fetch(`${url}/message/sendMedia/${inst}`, {
      method: 'POST',
      headers: { 'apikey': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number,
        mediatype: 'image',
        mimetype: 'image/webp',
        media: 'https://www.ilocarpay.com.br/logo.webp',
        caption: text
      })
    });
  } catch (e) {
    console.warn('[whatsapp] falha ao enviar:', e.message);
  }
}

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({
    credential: cert(JSON.parse(process.env.ILOCARPAY_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT)),
    storageBucket: BUCKET
  });
}

function extractDocumentId(payload) {
  return payload?.object?.id || null;
}

function extractEvent(payload) {
  return (payload?.event || '').toLowerCase();
}

function extractSignerStep(payload) {
  const subjectId = payload?.subject?.id;
  const signers = payload?.object?.assignment?.signers || [];
  const signer = signers.find(s => s.id === subjectId);
  return signer?.step ?? null;
}

function isFullySigned(event) {
  return ['document_ready', 'document_completed', 'assignment.completed', 'completed', 'finished'].some(e => event.includes(e));
}

function isSignerSignedDocument(event) {
  return event === 'signer_signed_document';
}

async function assinafyGet(apiKey, path) {
  const r = await fetch(`${ASSINAFY}/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// Coleta log de auditoria de todos os signatários do assignment
async function collectAuditTrail(apiKey, documentId, assignmentId) {
  try {
    const accountsResp = await assinafyGet(apiKey, 'accounts');
    const accountId = accountsResp?.data?.[0]?.id;
    if (!accountId) return [];

    const path = assignmentId
      ? `accounts/${accountId}/documents/${documentId}/assignments/${assignmentId}`
      : `accounts/${accountId}/documents/${documentId}/assignments`;

    const resp = assignmentId
      ? await assinafyGet(apiKey, path)
      : null;

    const assignment = resp?.data || null;
    const signers = assignment?.signers || [];

    return signers.map(s => ({
      email:      s.email       || null,
      name:       s.full_name   || null,
      status:     s.status      || null,
      signedAt:   s.signed_at   || null,
      viewedAt:   s.viewed_at   || null,
      ipAddress:  s.ip_address  || s.ip || null,
      latitude:   s.latitude    || s.lat || null,
      longitude:  s.longitude   || s.lng || null,
      step:       s.step        || null,
      signatureHash: s.signature_hash || s.hash || null
    }));
  } catch (e) {
    console.warn('[assinafy-webhook] falha ao coletar audit trail:', e.message);
    return [];
  }
}

// Baixa o PDF assinado do Assinafy e faz upload para Firebase Storage
async function archiveSignedPdf(apiKey, documentId, contractId) {
  try {
    const docResp   = await assinafyGet(apiKey, `documents/${documentId}`);
    const artifacts = docResp?.data?.artifacts || {};
    const signedUrl = artifacts.certificated || artifacts.bundle || artifacts.original;
    const docHash   = docResp?.data?.hash || docResp?.data?.document_hash || null;

    if (!signedUrl) {
      console.warn(`[assinafy-webhook] URL do PDF assinado não encontrada para ${documentId}`);
      return { storagePath: null, documentHash: docHash };
    }

    const pdfResp = await fetch(signedUrl, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/pdf,*/*' }
    });
    if (!pdfResp.ok) {
      console.warn(`[assinafy-webhook] falha ao baixar PDF: HTTP ${pdfResp.status}`);
      return { storagePath: null, documentHash: docHash };
    }

    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    const storagePath = `signed_contracts/${contractId}.pdf`;
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);

    await file.save(pdfBuffer, {
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          contractId,
          assinafyDocumentId: documentId,
          archivedAt: new Date().toISOString()
        }
      }
      // Google Cloud Storage criptografa todos os dados em repouso por padrão (Google-managed keys)
    });

    console.log(`[assinafy-webhook] PDF arquivado em ${storagePath} (${pdfBuffer.length} bytes)`);
    return { storagePath, documentHash: docHash };
  } catch (e) {
    console.warn('[assinafy-webhook] falha ao arquivar PDF:', e.message);
    return { storagePath: null, documentHash: null };
  }
}

function formatBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatMonthYear(dateStr) {
  if (!dateStr) return '';
  const [y, m] = dateStr.split('-');
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${months[parseInt(m) - 1]}/${y}`;
}

async function handleAsaasPayment(db, payment) {
  const asaasChargeId = payment.id;
  if (!asaasChargeId) return { skipped: 'payment.id ausente' };

  const snap = await db.collection('charges')
    .where('asaasChargeId', '==', asaasChargeId)
    .limit(1).get();

  if (snap.empty) return { skipped: 'cobrança não encontrada' };

  const chargeRef = snap.docs[0].ref;
  const chargeId  = snap.docs[0].id;
  const charge    = snap.docs[0].data();

  if (charge.status === 'paid') return { skipped: 'já estava pago' };

  await chargeRef.update({
    status:    'paid',
    paidAt:    FieldValue.serverTimestamp(),
    paidValue: payment.value || charge.totalAmount
  });

  const [tenantSnap, contractSnap] = await Promise.all([
    charge.tenantId   ? db.collection('users').doc(charge.tenantId).get()       : Promise.resolve(null),
    charge.contractId ? db.collection('contracts').doc(charge.contractId).get() : Promise.resolve(null)
  ]);

  const tenant   = tenantSnap?.data()   || {};
  const contract = contractSnap?.data() || {};

  const tenantName    = tenant.name          || charge.tenantName   || 'Inquilino';
  const endereco      = contract.address     || charge.address      || charge.description || 'o imóvel';
  const valor         = formatBRL(payment.value || charge.totalAmount);
  const periodo       = formatMonthYear(payment.dueDate || charge.dueDate?.toDate?.()?.toISOString()?.slice(0, 10));
  const tenantPhone   = tenant.phone          || charge.tenantPhone   || null;
  const landlordPhone = contract.landlordPhone || charge.landlordPhone || null;
  const brokerPhone   = contract.brokerPhone  || charge.brokerPhone   || contract.corretorPhone || null;

  const billingTypeMap = { PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito', DEBIT_CARD: 'Cartão de débito', BOLETO: 'Boleto' };
  const meio = billingTypeMap[payment.billingType] || payment.billingType || 'não informado';

  const msgTenant  = `✅ *iiLocarPay* — Pagamento confirmado!\n\nRecebemos seu pagamento de *${valor}* via *${meio}* referente ao aluguel de *${periodo}* do imóvel ${endereco}.\n\nObrigado! 🏠`;
  const msgOwner   = `💰 *iiLocarPay* — Aluguel recebido!\n\nO inquilino *${tenantName}* realizou o pagamento de *${valor}* via *${meio}* ref. ${periodo} — imóvel: ${endereco}.\n\nO repasse será processado em até 2 dias úteis.`;
  const msgBroker  = `📋 *iiLocarPay* — Pagamento confirmado\n\n*Inquilino:* ${tenantName}\n*Valor:* ${valor}\n*Meio:* ${meio}\n*Período:* ${periodo}\n*Imóvel:* ${endereco}\n\nCobrança ID: ${chargeId}`;

  await Promise.all([
    sendWhatsApp(tenantPhone,   msgTenant),
    sendWhatsApp(landlordPhone, msgOwner),
    sendWhatsApp(brokerPhone,   msgBroker)
  ]);

  console.log(`[asaas-webhook] WhatsApp enviado — chargeId:${chargeId} valor:${valor}`);
  return { ok: true, chargeId, paidValue: payment.value };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'ilocarpay-assinafy-webhook' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};

  // Rota Asaas: payload tem payment.id e event começa com PAYMENT_
  const asaasEvent = (payload.event || '').toUpperCase();
  if (payload.payment?.id && ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(asaasEvent)) {
    try {
      initAdmin();
      const db = getFirestore();
      const result = await handleAsaasPayment(db, payload.payment);
      return res.status(200).json(result);
    } catch (e) {
      console.error('[asaas-webhook] erro:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  console.log('[assinafy-webhook] payload:', JSON.stringify(payload));

  const event = extractEvent(payload);
  const documentId = extractDocumentId(payload);

  if (!documentId) {
    console.warn('[assinafy-webhook] documentId ausente');
    return res.status(200).json({ ok: true, skipped: 'documentId não encontrado' });
  }

  try {
    initAdmin();
    const db = getFirestore();

    const snap = await db.collection('contracts')
      .where('assinafyDocumentId', '==', documentId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn(`[assinafy-webhook] contrato não encontrado para documentId=${documentId}`);
      return res.status(200).json({ ok: true, skipped: 'contrato não encontrado' });
    }

    const contractRef  = snap.docs[0].ref;
    const contractId   = snap.docs[0].id;
    const contractData = snap.docs[0].data();
    const updates = {};

    // Busca o lead vinculado para atualizar contractStatus em tempo real
    const leadSnap = contractData.leadId
      ? await db.collection('leads').doc(contractData.leadId).get()
      : (await db.collection('leads').where('contractId', '==', contractId).limit(1).get()).docs[0] || null;
    const leadRef = leadSnap?.ref || null;

    if (isFullySigned(event)) {
      updates.assinafyStatus  = 'completed';
      updates.ownerSigned     = true;
      updates.bothSigned      = true;
      updates.contractStatus  = 'CONTRATO_ASSINADO';
      updates.signedAt        = FieldValue.serverTimestamp();
      updates.updatedAt       = FieldValue.serverTimestamp();
      console.log(`[assinafy-webhook] contrato ${contractId} concluído — iniciando arquivamento`);

      // Propaga status ao lead (lido em tempo real pelo app do corretor)
      if (leadRef) {
        await leadRef.update({
          contractStatus: 'CONTRATO_ASSINADO',
          bothSigned:     true,
          updatedAt:      FieldValue.serverTimestamp()
        });
      }

      const configSnap = await db.collection('config').doc('assinafy').get();
      const apiKey = configSnap.data()?.apiKey;

      if (apiKey) {
        const assignmentId = contractData.assinafyAssignmentId || null;

        const auditTrail = await collectAuditTrail(apiKey, documentId, assignmentId);
        if (auditTrail.length > 0) {
          updates.auditTrail = auditTrail;
          console.log(`[assinafy-webhook] audit trail salvo: ${auditTrail.length} signatário(s)`);
        }

        const { storagePath, documentHash } = await archiveSignedPdf(apiKey, documentId, contractId);
        if (storagePath) updates.signedStoragePath = storagePath;
        if (documentHash) updates.documentHash = documentHash;

        const endereco   = contractData.address    || contractData.endereco || 'o imóvel';
        const msgConcluido = `🎉 *iiLocarPay*: Contrato de locação do imóvel ${endereco} assinado por todas as partes! Acesse o app para visualizar o documento.`;
        await Promise.all([
          sendWhatsApp(contractData.landlordPhone, msgConcluido),
          sendWhatsApp(contractData.brokerPhone || contractData.corretorPhone, msgConcluido),
          sendWhatsApp(contractData.tenantPhone || contractData.inquilinoPhone, msgConcluido)
        ]);
      } else {
        console.warn('[assinafy-webhook] API key Assinafy não encontrada — audit trail e PDF não arquivados');
      }

    } else if (isSignerSignedDocument(event)) {
      const step = extractSignerStep(payload);

      const subject = payload?.subject || {};
      const signer  = (payload?.object?.assignment?.signers || []).find(s => s.id === subject.id) || {};
      const auditEvent = {
        email:     signer.email      || subject.email || null,
        name:      signer.full_name  || null,
        status:    signer.status     || 'signed',
        signedAt:  signer.signed_at  || new Date().toISOString(),
        viewedAt:  signer.viewed_at  || null,
        ipAddress: signer.ip_address || signer.ip || null,
        latitude:  signer.latitude   || null,
        longitude: signer.longitude  || null,
        step:      signer.step       || step
      };
      updates.auditTrail = FieldValue.arrayUnion(auditEvent);
      updates.updatedAt  = FieldValue.serverTimestamp();

      const endereco = contractData.address || contractData.endereco || contractData.propertyAddress || 'o imóvel';

      if (step === 1) {
        // Proprietário assinou → inquilino é o próximo (Assinafy envia o e-mail automaticamente por ser step 2)
        updates.ownerSigned    = true;
        updates.contractStatus = 'AGUARDANDO_INQUILINO';
        if (leadRef) {
          await leadRef.update({
            contractStatus: 'AGUARDANDO_INQUILINO',
            updatedAt:      FieldValue.serverTimestamp()
          });
        }
        console.log(`[assinafy-webhook] proprietário assinou contrato ${contractId} → AGUARDANDO_INQUILINO`);

        const tenantName  = contractData.tenantName || contractData.inquilinoNome || 'Inquilino';
        const tenantEmail = contractData.tenantEmail || '';
        const msgInquilino = `Olá, ${tenantName}! 📝\n\nO proprietário assinou o contrato de locação do imóvel *${endereco}*. O contrato agora está no seu e-mail (${tenantEmail}) aguardando a sua assinatura digital.\n\nPor favor, verifique sua caixa de entrada e assine para concluir a locação.\n\n— iiLocarPay`;
        await sendWhatsApp(contractData.tenantPhone || contractData.inquilinoPhone, msgInquilino);

      } else {
        // Inquilino assinou (step 2) — evento de conclusão vem separado via isFullySigned
        updates.contractStatus = 'CONTRATO_ASSINADO';
        updates.bothSigned     = true;
        updates.signedAt       = FieldValue.serverTimestamp();
        if (leadRef) {
          await leadRef.update({
            contractStatus: 'CONTRATO_ASSINADO',
            bothSigned:     true,
            updatedAt:      FieldValue.serverTimestamp()
          });
        }
        console.log(`[assinafy-webhook] inquilino assinou contrato ${contractId} → CONTRATO_ASSINADO`);

        const tenantName = contractData.tenantName || contractData.inquilinoNome || 'O inquilino';
        const msg = `✅ *iiLocarPay*: ${tenantName} assinou o contrato de locação do imóvel *${endereco}*. Acesse o app para verificar.`;
        await Promise.all([
          sendWhatsApp(contractData.landlordPhone, msg),
          sendWhatsApp(contractData.brokerPhone || contractData.corretorPhone, msg)
        ]);
      }

    } else {
      console.log(`[assinafy-webhook] evento '${event}' não mapeado`);
      return res.status(200).json({ ok: true, skipped: `evento '${event}' não mapeado` });
    }

    if (Object.keys(updates).length > 0) {
      await contractRef.update(updates);
    }

    return res.status(200).json({ ok: true, contractId, updates: Object.keys(updates) });
  } catch (e) {
    console.error('[assinafy-webhook] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
