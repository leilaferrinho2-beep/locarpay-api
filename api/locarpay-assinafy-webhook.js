// POST /api/locarpay-assinafy-webhook
// Recebe eventos da Assinafy quando um signatário assina ou o documento é concluído.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({ credential: cert(JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT)) });
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'locarpay-assinafy-webhook' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};
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

    // Busca contrato pelo assinafyDocumentId usando Admin SDK
    const snap = await db.collection('contracts')
      .where('assinafyDocumentId', '==', documentId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn(`[assinafy-webhook] contrato não encontrado para documentId=${documentId}`);
      return res.status(200).json({ ok: true, skipped: 'contrato não encontrado' });
    }

    const contractRef = snap.docs[0].ref;
    const contractId  = snap.docs[0].id;
    const updates = {};

    if (isFullySigned(event)) {
      updates.assinafyStatus = 'completed';
      updates.ownerSigned    = true;
      updates.signedAt       = FieldValue.serverTimestamp();
      console.log(`[assinafy-webhook] contrato ${contractId} concluído`);
    } else if (isSignerSignedDocument(event)) {
      const step = extractSignerStep(payload);
      updates.ownerSigned = true;
      if (step !== 1 && step !== null) {
        updates.assinafyStatus = 'completed';
        updates.signedAt = FieldValue.serverTimestamp();
      }
      console.log(`[assinafy-webhook] signatário assinou contrato ${contractId} (step=${step})`);
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
