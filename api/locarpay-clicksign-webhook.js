// POST /api/locarpay-clicksign-webhook
// Recebe eventos da Clicksign quando alguém assina ou o documento é finalizado.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const CLICKSIGN_BASE = process.env.CLICKSIGN_BASE_URL || 'https://sandbox.clicksign.com/api/v1';
const FB_PROJECT     = 'locarpayapp';
const BUCKET         = `${FB_PROJECT}.appspot.com`;

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({
    credential: cert(JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT)),
    storageBucket: BUCKET
  });
}

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

// Baixa o PDF assinado da Clicksign e arquiva no Firebase Storage
async function archiveSignedPdf(signedFileUrl, contractId) {
  try {
    const t = process.env.CLICKSIGN_ACCESS_TOKEN;
    const pdfResp = await fetch(signedFileUrl + (t ? `?access_token=${t}` : ''), {
      headers: { 'Accept': 'application/pdf,*/*' }
    });
    if (!pdfResp.ok) {
      console.warn(`[clicksign-webhook] falha ao baixar PDF: HTTP ${pdfResp.status}`);
      return null;
    }
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    const storagePath = `signed_contracts/${contractId}.pdf`;
    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(pdfBuffer, {
      metadata: {
        contentType: 'application/pdf',
        metadata: { contractId, archivedAt: new Date().toISOString() }
      }
    });
    console.log(`[clicksign-webhook] PDF arquivado: ${storagePath} (${pdfBuffer.length} bytes)`);
    return storagePath;
  } catch (e) {
    console.warn('[clicksign-webhook] falha ao arquivar PDF:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET') return res.status(200).json({ ok: true, endpoint: 'locarpay-clicksign-webhook' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = req.body || {};
  console.log('[clicksign-webhook] payload:', JSON.stringify(payload).slice(0, 500));

  const eventName    = payload?.event?.name || '';
  const docData      = payload?.event?.data?.document || {};
  const signerData   = payload?.event?.data?.signer   || {};
  const documentKey  = docData.key || '';
  const docStatus    = (docData.status || '').toLowerCase();

  if (!documentKey) {
    console.warn('[clicksign-webhook] documentKey ausente');
    return res.status(200).json({ ok: true, skipped: 'documentKey ausente' });
  }

  try {
    initAdmin();
    const db = getFirestore();

    const snap = await db.collection('contracts')
      .where('clicksignDocumentKey', '==', documentKey)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn(`[clicksign-webhook] contrato não encontrado para key=${documentKey}`);
      return res.status(200).json({ ok: true, skipped: 'contrato não encontrado' });
    }

    const contractRef  = snap.docs[0].ref;
    const contractId   = snap.docs[0].id;
    const contractData = snap.docs[0].data();
    const updates = {};

    // Busca lead vinculado
    const leadSnap = contractData.leadId
      ? await db.collection('leads').doc(contractData.leadId).get()
      : (await db.collection('leads').where('contractId', '==', contractId).limit(1).get()).docs[0] || null;
    const leadRef = leadSnap?.ref || null;

    const endereco = contractData.address || contractData.propertyAddress || contractData.propertyDescription || 'o imóvel';

    // ── Evento: alguém assinou ───────────────────────────────────────────────
    if (eventName === 'sign') {
      const auditEvent = {
        email:    signerData.email    || null,
        name:     signerData.name     || null,
        status:   'signed',
        signedAt: signerData.signed_at || new Date().toISOString(),
        ipAddress: signerData.ip_address || null
      };
      updates.auditTrail = FieldValue.arrayUnion(auditEvent);
      updates.updatedAt  = FieldValue.serverTimestamp();

      // Verifica se o proprietário foi o primeiro a assinar
      const alreadyOwnerSigned = contractData.ownerSigned === true;
      if (!alreadyOwnerSigned) {
        updates.ownerSigned    = true;
        updates.contractStatus = 'AGUARDANDO_INQUILINO';
        if (leadRef) {
          await leadRef.update({
            contractStatus: 'AGUARDANDO_INQUILINO',
            updatedAt: FieldValue.serverTimestamp()
          });
        }
        const tenantName  = contractData.tenantName  || 'Inquilino';
        const tenantEmail = contractData.tenantEmail || '';
        const msgInquilino = `Olá, ${tenantName}! 📝\n\nO proprietário assinou o contrato de locação do imóvel *${endereco}*. O link para assinatura foi enviado para *${tenantEmail}*.\n\nVerifique sua caixa de entrada e assine para concluir a locação.\n\n— iLocarPay`;
        await sendWhatsApp(contractData.tenantPhone || contractData.inquilinoPhone, msgInquilino);
        console.log(`[clicksign-webhook] proprietário assinou contrato ${contractId} → AGUARDANDO_INQUILINO`);
      } else {
        // Inquilino (ou fiador) assinou
        const signerEmail = signerData.email || '';
        const isTenant = signerEmail.toLowerCase() === (contractData.tenantEmail || '').toLowerCase();
        if (isTenant) {
          updates.contractStatus = 'AGUARDANDO_CONCLUSAO';
          if (leadRef) await leadRef.update({ contractStatus: 'AGUARDANDO_CONCLUSAO', updatedAt: FieldValue.serverTimestamp() });
          const tenantName = contractData.tenantName || 'O inquilino';
          const msg = `✍️ *iLocarPay*: ${tenantName} assinou o contrato do imóvel *${endereco}*. Aguardando finalização.`;
          await Promise.all([
            sendWhatsApp(contractData.landlordPhone, msg),
            sendWhatsApp(contractData.brokerPhone || contractData.corretorPhone, msg)
          ]);
        }
        console.log(`[clicksign-webhook] ${signerEmail} assinou contrato ${contractId}`);
      }

    // ── Evento: documento fechado (todos assinaram) ───────────────────────────
    } else if (eventName === 'close' || eventName === 'auto_close' || docStatus === 'closed') {
      updates.clicksignStatus = 'closed';
      updates.contractStatus  = 'CONTRATO_ASSINADO';
      updates.bothSigned      = true;
      updates.ownerSigned     = true;
      updates.signedAt        = FieldValue.serverTimestamp();
      updates.updatedAt       = FieldValue.serverTimestamp();

      const signedFileUrl = docData.downloads?.signed_file_url || null;
      if (signedFileUrl) {
        updates.signedFileUrl = signedFileUrl;
        const storagePath = await archiveSignedPdf(signedFileUrl, contractId);
        if (storagePath) updates.signedStoragePath = storagePath;
      }

      if (leadRef) {
        await leadRef.update({
          contractStatus: 'CONTRATO_ASSINADO',
          bothSigned: true,
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      const msgConcluido = `🎉 *iLocarPay*: Contrato de locação do imóvel *${endereco}* assinado por todas as partes! Acesse o app para visualizar o documento.`;
      await Promise.all([
        sendWhatsApp(contractData.landlordPhone,  msgConcluido),
        sendWhatsApp(contractData.brokerPhone || contractData.corretorPhone, msgConcluido),
        sendWhatsApp(contractData.tenantPhone || contractData.inquilinoPhone, msgConcluido)
      ]);
      console.log(`[clicksign-webhook] contrato ${contractId} finalizado — CONTRATO_ASSINADO`);

    } else {
      console.log(`[clicksign-webhook] evento '${eventName}' não mapeado`);
      return res.status(200).json({ ok: true, skipped: `evento '${eventName}' não mapeado` });
    }

    if (Object.keys(updates).length > 0) {
      await contractRef.update(updates);
    }

    return res.status(200).json({ ok: true, contractId, eventName });
  } catch (e) {
    console.error('[clicksign-webhook] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
