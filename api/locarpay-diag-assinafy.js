// GET /api/locarpay-diag-assinafy?email=TENANT_EMAIL
// Temporário — diagnóstico da API Assinafy

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const configSnap = await fetch(`${FS_BASE}/config/assinafy?key=${FB_API_KEY}`).then(r => r.json());
    const apiKey = configSnap?.fields?.apiKey?.stringValue;
    if (!apiKey) return res.status(500).json({ error: 'API key não encontrada' });

    const accounts = await assinafyGet(apiKey, 'accounts');
    const accountId = accounts?.data?.[0]?.id;
    if (!accountId) return res.status(500).json({ error: 'Account não encontrado', accounts });

    const docs = await assinafyGet(apiKey, `accounts/${accountId}/documents`);

    const email = req.query.email;
    let contractData = null;
    if (email) {
      const q = await fetch(`${FS_BASE}:runQuery?key=${FB_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: 'contracts' }],
          where: { fieldFilter: { field: { fieldPath: 'tenantEmail' }, op: 'EQUAL', value: { stringValue: email } } },
          limit: 1
        }})
      }).then(r => r.json());
      const doc = q.find(row => row.document)?.document;
      if (doc) {
        const f = doc.fields;
        const docId = f.assinafyDocumentId?.stringValue;
        contractData = { docId, signedFileUrl: f.signedFileUrl?.stringValue, status: f.assinafyStatus?.stringValue };
        if (docId && accountId) {
          contractData.getDocumentResp = await assinafyGet(apiKey, `accounts/${accountId}/documents/${docId}`);
        }
      }
    }

    return res.status(200).json({ accountId, docs, contractData });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
