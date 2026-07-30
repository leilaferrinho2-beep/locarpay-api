// POST /api/locarpay-check-signatures
// Verifica se um contrato foi assinado por ambas as partes via Assinafy.
// Chamado pelo app do inquilino ao clicar em "Verificar assinaturas".

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({ credential: cert(JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tenantEmail } = req.body || {};
  if (!tenantEmail) return res.status(400).json({ error: 'tenantEmail obrigatório' });

  try {
    initAdmin();
    const db = getFirestore();

    // Busca contrato ativo pelo email do inquilino
    const contractSnap = await db.collection('contracts')
      .where('tenantEmail', '==', tenantEmail.toLowerCase().trim())
      .where('active', '==', true)
      .limit(1)
      .get();

    if (contractSnap.empty) {
      return res.status(404).json({ error: 'Contrato não encontrado' });
    }

    const contractDoc = contractSnap.docs[0];
    const contract = contractDoc.data();
    const contractId = contractDoc.id;

    // Se já está marcado como concluído no Firestore, retorna direto
    const doneStatuses = ['completed', 'signed', 'finished', 'done', 'approved', 'executed', 'manual', 'concluded', 'closed', 'active', 'certificated'];
    if (doneStatuses.includes((contract.assinafyStatus || '').toLowerCase())) {
      return res.status(200).json({ signed: true, status: contract.assinafyStatus });
    }

    // Sem documento Assinafy: não pode verificar
    const documentId   = contract.assinafyDocumentId;
    const assignmentId = contract.assinafyAssignmentId;
    if (!documentId) {
      return res.status(200).json({ signed: false, status: 'no_document' });
    }

    // Busca API key da Assinafy no Firestore (Admin SDK tem acesso)
    const configDoc = await db.collection('config').document('assinafy').get();
    const apiKey = configDoc.exists ? configDoc.data().apiKey : null;
    if (!apiKey) {
      return res.status(200).json({ signed: false, status: 'no_api_key' });
    }

    // Obtém conta Assinafy
    const accountsRes = await fetchJson('https://app.assinafy.com.br/api/v1/accounts', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const accountId = accountsRes.data?.data?.[0]?.id;
    if (!accountId) {
      return res.status(200).json({ signed: false, status: 'no_account' });
    }

    // Verifica status do documento
    const docRes = await fetchJson(
      `https://app.assinafy.com.br/api/v1/accounts/${accountId}/documents/${documentId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    const docStatus = (docRes.data?.data?.status || '').toLowerCase();
    if (doneStatuses.some(s => docStatus.includes(s))) {
      const updates = { assinafyStatus: 'completed', ownerSigned: true };
      const signedUrl = docRes.data?.data?.signed_url || docRes.data?.data?.signedUrl;
      if (signedUrl) updates.signedFileUrl = signedUrl;
      await contractDoc.ref.update(updates);
      return res.status(200).json({ signed: true, status: 'completed' });
    }

    // Verifica assignment para status individual dos signatários
    if (assignmentId) {
      const assignRes = await fetchJson(
        `https://app.assinafy.com.br/api/v1/accounts/${accountId}/documents/${documentId}/assignments/${assignmentId}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      const signers = assignRes.data?.data?.signers || [];
      const signedStatuses = ['signed', 'completed', 'approved', 'finished', 'done', 'concluded'];
      const ownerSigner = signers.find(s => s.step === 1) || signers[0];
      const tenantSigner = signers.find(s => s.step === 2) || signers[1];
      const ownerSignedApi = ownerSigner?.signed_at != null || signedStatuses.includes((ownerSigner?.status || '').toLowerCase());
      const tenantSignedApi = tenantSigner?.signed_at != null || signedStatuses.includes((tenantSigner?.status || '').toLowerCase());

      if (ownerSignedApi && tenantSignedApi) {
        await contractDoc.ref.update({ assinafyStatus: 'completed', ownerSigned: true });
        return res.status(200).json({ signed: true, status: 'completed' });
      }

      // Atualiza ownerSigned se o proprietário já assinou
      if (ownerSignedApi && !contract.ownerSigned) {
        await contractDoc.ref.update({ ownerSigned: true });
      }

      return res.status(200).json({
        signed: false,
        ownerSigned: ownerSignedApi || contract.ownerSigned || false,
        tenantSigned: tenantSignedApi,
        tenantSignUrl: !tenantSignedApi ? (tenantSigner?.sign_url || null) : null
      });
    }

    return res.status(200).json({ signed: false, status: docStatus || 'pending' });
  } catch (e) {
    console.error('[check-signatures] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
