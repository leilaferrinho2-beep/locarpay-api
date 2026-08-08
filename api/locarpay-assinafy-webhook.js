// POST /api/locarpay-assinafy-webhook
// Recebe eventos da Assinafy quando um signatário assina ou o documento é concluído.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const ASSINAFY   = 'https://api.assinafy.com.br/v1';
const FB_PROJECT = 'locarpayapp';
const BUCKET     = `${FB_PROJECT}.appspot.com`;

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({
    credential: cert(JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT)),
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

    if (isFullySigned(event)) {
      updates.assinafyStatus = 'completed';
      updates.ownerSigned    = true;
      updates.signedAt       = FieldValue.serverTimestamp();
      console.log(`[assinafy-webhook] contrato ${contractId} concluído — iniciando arquivamento`);

      // Busca API key do Assinafy
      const configSnap = await db.collection('config').doc('assinafy').get();
      const apiKey = configSnap.data()?.apiKey;

      if (apiKey) {
        const assignmentId = contractData.assinafyAssignmentId || null;

        // 1. Coleta log de auditoria
        const auditTrail = await collectAuditTrail(apiKey, documentId, assignmentId);
        if (auditTrail.length > 0) {
          updates.auditTrail = auditTrail;
          console.log(`[assinafy-webhook] audit trail salvo: ${auditTrail.length} signatário(s)`);
        }

        // 2. Arquiva PDF assinado no Firebase Storage
        const { storagePath, documentHash } = await archiveSignedPdf(apiKey, documentId, contractId);
        if (storagePath) updates.signedStoragePath = storagePath;
        if (documentHash) updates.documentHash = documentHash;
      } else {
        console.warn('[assinafy-webhook] API key Assinafy não encontrada — audit trail e PDF não arquivados');
      }

    } else if (isSignerSignedDocument(event)) {
      const step = extractSignerStep(payload);
      updates.ownerSigned = true;
      if (step !== 1 && step !== null) {
        updates.assinafyStatus = 'completed';
        updates.signedAt = FieldValue.serverTimestamp();
      }

      // Salva evento parcial de auditoria a partir do payload do webhook
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
