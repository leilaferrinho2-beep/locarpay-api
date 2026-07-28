// POST /api/locarpay-fix-signed-url { tenantEmail }
// Busca na Assinafy o documento certificado do inquilino e atualiza Firestore

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

async function assinafyGet(apiKey, path) {
  const r = await fetch(`https://api.assinafy.com.br/v1/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function fsPatch(path, fields) {
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}&${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`Firestore PATCH: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { tenantEmail } = req.body || {};
  if (!tenantEmail) return res.status(400).json({ error: 'tenantEmail obrigatório' });

  try {
    const configSnap = await fetch(`${FS_BASE}/config/assinafy?key=${FB_API_KEY}`).then(r => r.json());
    const apiKey = configSnap?.fields?.apiKey?.stringValue;
    if (!apiKey) return res.status(500).json({ error: 'API key não encontrada' });

    const accounts = await assinafyGet(apiKey, 'accounts');
    const accountId = accounts?.data?.[0]?.id;
    if (!accountId) return res.status(500).json({ error: 'Account não encontrado' });

    const docsResp = await assinafyGet(apiKey, `accounts/${accountId}/documents`);
    const docs = docsResp?.data || [];

    // Encontra o documento certificado onde o inquilino é signatário
    const emailLc = tenantEmail.toLowerCase();
    const found = docs.find(doc => {
      if (!['certificated', 'signed', 'completed'].includes(doc.status?.toLowerCase())) return false;
      const signers = doc.assignment?.signers || [];
      return signers.some(s => s.email?.toLowerCase() === emailLc);
    });

    if (!found) return res.status(404).json({ error: 'Documento certificado não encontrado', docsCount: docs.length });

    const signedUrl = found.artifacts?.certificated || found.artifacts?.bundle || found.download_url;
    if (!signedUrl) return res.status(404).json({ error: 'URL do documento não encontrada', found: found.id });

    // Busca contrato no Firestore
    const q = await fetch(`${FS_BASE}:runQuery?key=${FB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: 'contracts' }],
        where: { fieldFilter: { field: { fieldPath: 'tenantEmail' }, op: 'EQUAL', value: { stringValue: tenantEmail } } },
        limit: 1
      }})
    }).then(r => r.json());

    const contractDoc = q.find(row => row.document)?.document;
    if (!contractDoc) return res.status(404).json({ error: 'Contrato não encontrado no Firestore' });

    const contractId = contractDoc.name.split('/').pop();

    // Atualiza Firestore
    await fetch(`${FS_BASE}/contracts/${contractId}?key=${FB_API_KEY}&updateMask.fieldPaths=assinafyDocumentId&updateMask.fieldPaths=signedFileUrl&updateMask.fieldPaths=assinafyStatus`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        assinafyDocumentId: { stringValue: found.id },
        signedFileUrl: { stringValue: signedUrl },
        assinafyStatus: { stringValue: found.status }
      }})
    });

    return res.status(200).json({ ok: true, contractId, docId: found.id, signedUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
