// POST /api/iilocarpay-sync-status
// Consulta Assinafy e retorna status de assinaturas para o app do inquilino.
// Body: { tenantEmail: string }

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const ASSINAFY = 'https://api.assinafy.com.br/v1';

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({ credential: cert(JSON.parse(process.env.ILOCARPAY_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

async function assinafyGet(apiKey, path) {
  const r = await fetch(`${ASSINAFY}/${path}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
  });
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tenantEmail } = req.body || {};
  if (!tenantEmail) return res.status(400).json({ error: 'tenantEmail obrigatório' });

  try {
    initAdmin();
    const db = getFirestore();

    // Busca contrato pelo email do inquilino
    const snap = await db.collection('contracts')
      .where('tenantEmail', '==', tenantEmail)
      .limit(1).get();

    if (snap.empty) return res.status(200).json({ signed: false, ownerSigned: false, tenantSigned: false });

    const contract    = snap.docs[0].data();
    const contractId  = snap.docs[0].id;
    const contractRef = snap.docs[0].ref;
    const documentId  = contract.assinafyDocumentId;

    if (!documentId) {
      return res.status(200).json({
        signed: false, ownerSigned: false, tenantSigned: false, tenantSignUrl: null
      });
    }

    // Consulta Assinafy em tempo real
    const configSnap = await db.collection('config').doc('assinafy').get();
    const apiKey = configSnap.data()?.apiKey;
    if (!apiKey) return res.status(200).json({ signed: false, ownerSigned: false, tenantSigned: false });

    const docData = await assinafyGet(apiKey, `documents/${documentId}`);
    const doc = docData?.data || {};
    const signers = doc?.assignment?.signers || [];

    const s1 = signers.find(s => s.step === 1) || {};
    const s2 = signers.find(s => s.step === 2) || {};

    const ownerSigned  = !!s1.completed;
    const tenantSigned = !!s2.completed;
    const allSigned    = ownerSigned && tenantSigned;

    // URL de assinatura do inquilino (disponível quando proprietário já assinou)
    const signingUrls = doc?.assignment?.signing_urls || [];
    const s2Id = contract.assinafySignerId2 || s2.id;
    const tenantSignUrl = ownerSigned && !tenantSigned && s2Id
      ? (signingUrls.find(u => u.signer_id === s2Id)?.url ?? null)
      : null;

    // Atualiza Firestore se status mudou
    const updates = {};
    if (ownerSigned  && !contract.ownerSigned)  updates.ownerSigned  = true;
    if (tenantSigned && !contract.tenantSigned) updates.tenantSigned = true;
    if (allSigned && contract.contractStatus !== 'CONTRATO_ASSINADO') {
      updates.contractStatus = 'CONTRATO_ASSINADO';
      updates.assinafyStatus = 'completed';
      updates.bothSigned     = true;
      updates.signedAt       = FieldValue.serverTimestamp();
    } else if (ownerSigned && contract.contractStatus === 'AGUARDANDO_PROPRIETARIO') {
      updates.contractStatus = 'AGUARDANDO_INQUILINO';
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = FieldValue.serverTimestamp();
      await contractRef.update(updates);
      console.log(`[sync-status] contrato ${contractId} atualizado:`, Object.keys(updates));
    }

    return res.status(200).json({
      signed:       allSigned,
      ownerSigned,
      tenantSigned,
      tenantSignUrl,
      contractId
    });
  } catch (e) {
    console.error('[sync-status] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
