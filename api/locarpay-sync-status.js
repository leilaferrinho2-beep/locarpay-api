// POST /api/locarpay-sync-status  { tenantEmail }
// Verifica status de assinaturas via Assinafy e atualiza Firestore.
// Usado pelo app do inquilino ao clicar "Verificar assinaturas".

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({ credential: cert(JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

const DONE_STATUSES = ['completed', 'signed', 'finished', 'done', 'approved', 'executed', 'manual', 'concluded', 'closed', 'active', 'certificated'];
const SIGNED_STATUSES = ['signed', 'completed', 'approved', 'finished', 'done', 'concluded', 'active'];

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET') return res.status(200).json({ ok: true, endpoint: 'locarpay-sync-status' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tenantEmail, contractId } = req.body || {};
  if (!tenantEmail && !contractId) return res.status(400).json({ error: 'tenantEmail ou contractId obrigatório' });

  try {
    initAdmin();
    const db = getFirestore();

    let contractSnap;
    if (contractId) {
      const doc = await db.collection('contracts').doc(contractId).get();
      contractSnap = doc.exists ? { empty: false, docs: [doc] } : { empty: true };
    } else {
      const email = tenantEmail.toLowerCase().trim();
      const snap = await db.collection('contracts')
        .where('tenantEmail', '==', email)
        .where('active', '==', true)
        .limit(1)
        .get();
      contractSnap = snap;
    }

    const email = contractId ? null : tenantEmail.toLowerCase().trim();

    if (contractSnap.empty) {
      return res.status(404).json({ error: 'Contrato não encontrado' });
    }

    const contractDoc = contractSnap.docs[0];
    const contract    = contractDoc.data();

    // Já está marcado como concluído no Firestore
    if (DONE_STATUSES.includes((contract.assinafyStatus || '').toLowerCase())) {
      return res.status(200).json({ signed: true, status: contract.assinafyStatus });
    }

    const documentId   = contract.assinafyDocumentId;
    const assignmentId = contract.assinafyAssignmentId;
    if (!documentId) {
      return res.status(200).json({ signed: false, status: 'no_document' });
    }

    // Busca API key da Assinafy (Admin SDK tem acesso a config/)
    const configDoc = await db.collection('config').doc('assinafy').get();
    const apiKey    = configDoc.exists ? configDoc.data().apiKey : null;
    if (!apiKey) {
      return res.status(200).json({ signed: false, status: 'no_api_key' });
    }

    // Conta Assinafy
    const accountsRes = await fetchJson('https://api.assinafy.com.br/v1/accounts', {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
    });
    const accountId = accountsRes.data?.data?.[0]?.id;
    if (!accountId) return res.status(200).json({ signed: false, status: 'no_account' });

    // Status geral do documento
    const docRes = await fetchJson(
      `https://api.assinafy.com.br/v1/accounts/${accountId}/documents/${documentId}`,
      { headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' } }
    );
    const docStatus = (docRes.data?.data?.status || '').toLowerCase();
    if (DONE_STATUSES.some(s => docStatus.includes(s))) {
      const updates = { assinafyStatus: 'completed', ownerSigned: true };
      const signedUrl = docRes.data?.data?.signed_url || docRes.data?.data?.signedUrl;
      if (signedUrl) updates.signedFileUrl = signedUrl;
      await contractDoc.ref.update(updates);
      return res.status(200).json({ signed: true, status: 'completed' });
    }

    // Status individual dos signatários
    if (assignmentId) {
      const assignRes = await fetchJson(
        `https://api.assinafy.com.br/v1/accounts/${accountId}/documents/${documentId}/assignments/${assignmentId}`,
        { headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' } }
      );
      const signers = assignRes.data?.data?.signers || [];

      const ownerSigner  = signers.find(s => s.step === 1) || signers[0];
      const tenantSigner = signers.find(s => s.step === 2) || signers[1];

      const ownerSignedApi  = ownerSigner?.signed_at  != null || SIGNED_STATUSES.includes((ownerSigner?.status  || '').toLowerCase());
      const tenantSignedApi = tenantSigner?.signed_at != null || SIGNED_STATUSES.includes((tenantSigner?.status || '').toLowerCase());

      if (ownerSignedApi && tenantSignedApi) {
        await contractDoc.ref.update({ assinafyStatus: 'completed', ownerSigned: true });
        return res.status(200).json({ signed: true, status: 'completed' });
      }
      if (ownerSignedApi && !contract.ownerSigned) {
        await contractDoc.ref.update({ ownerSigned: true });
      }
      return res.status(200).json({
        signed:        false,
        ownerSigned:   ownerSignedApi || contract.ownerSigned || false,
        tenantSigned:  tenantSignedApi,
        tenantSignUrl: !tenantSignedApi ? (tenantSigner?.sign_url || null) : null,
        _debug: { signers, docStatus }
      });
    }

    return res.status(200).json({ signed: false, status: docStatus || 'pending' });
  } catch (e) {
    console.error('[sync-status] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
