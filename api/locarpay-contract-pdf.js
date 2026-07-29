// GET /api/locarpay-contract-pdf?contractId=xxx
// Retorna a signed URL do PDF do contrato (sem expor a API key Assinafy para o cliente)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

async function assinafyGet(path, apiKey) {
  const r = await fetch(`https://app.assinafy.com.br/api/v1${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`Assinafy ${path} ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { contractId } = req.query;
  if (!contractId) return res.status(400).json({ error: 'contractId obrigatório' });

  try {
    initFirebase();
    const db = getFirestore();

    // Lê o contrato
    const contractSnap = await db.collection('contracts').doc(contractId).get();
    if (!contractSnap.exists) return res.status(404).json({ error: 'Contrato não encontrado' });
    const contract = contractSnap.data();

    // Se já tem URL cacheada, retorna direto
    if (contract.signedFileUrl) {
      return res.status(200).json({ url: contract.signedFileUrl });
    }

    if (!contract.assinafyDocumentId) {
      return res.status(404).json({ error: 'Contrato ainda não enviado para assinatura digital' });
    }

    // Lê API key Assinafy do backend (nunca exposta ao cliente)
    const configSnap = await db.collection('config').doc('assinafy').get();
    const apiKey = configSnap.data()?.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'Configuração Assinafy não encontrada' });

    // Busca a conta
    const accounts = await assinafyGet('/accounts', apiKey);
    const accountId = accounts.data?.[0]?.id;
    if (!accountId) return res.status(500).json({ error: 'Conta Assinafy não encontrada' });

    // Tenta buscar o documento pelo ID
    let signedUrl = null;
    try {
      const docRes = await assinafyGet(`/accounts/${accountId}/documents/${contract.assinafyDocumentId}`, apiKey);
      signedUrl = docRes.data?.signed_url || docRes.data?.signedUrl || null;
    } catch (_) {}

    // Fallback: lista documentos certificados
    if (!signedUrl) {
      try {
        const listRes = await assinafyGet(`/accounts/${accountId}/documents`, apiKey);
        const found = (listRes.data || []).find(d =>
          (d.is_certificated || d.isCertificated) && (d.signed_url || d.signedUrl)
        );
        if (found) signedUrl = found.signed_url || found.signedUrl;
      } catch (_) {}
    }

    if (!signedUrl) {
      return res.status(404).json({ error: 'Contrato assinado não encontrado na Assinafy' });
    }

    // Cacheia no Firestore para próximas chamadas
    await db.collection('contracts').doc(contractId).update({ signedFileUrl: signedUrl });

    return res.status(200).json({ url: signedUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
