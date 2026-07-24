// GET /api/locarpay-assinafy-debug
// Lista documentos e assignments da Assinafy para diagnóstico

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const ASSINAFY_BASE = 'https://api.assinafy.com.br/v1';

async function fsGet(path) {
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}`);
  if (!r.ok) throw new Error(`Firestore GET ${path}: ${r.status}`);
  return r.json();
}

async function assinafyGet(apiKey, path) {
  const r = await fetch(`${ASSINAFY_BASE}/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const configDoc = await fsGet('config/assinafy');
    const apiKey = configDoc?.fields?.apiKey?.stringValue;
    if (!apiKey) return res.status(500).json({ error: 'API key não encontrada' });

    const accountsResp = await assinafyGet(apiKey, 'accounts');
    const accountId = accountsResp?.data?.[0]?.id;
    if (!accountId) return res.status(500).json({ error: 'Conta não encontrada', accountsResp });

    const docsResp = await assinafyGet(apiKey, `accounts/${accountId}/documents?per_page=20`);
    const docs = (docsResp?.data || []).map(d => ({ id: d.id, name: d.name, status: d.status, created_at: d.created_at }));

    // Busca signer do inquilino e seu sign_url
    const tenantContactId = '19f9627fbc17af597148ca9494b';
    const results = {
      signer: await assinafyGet(apiKey, `accounts/${accountId}/signers/${tenantContactId}`),
      signerDocs: await assinafyGet(apiKey, `accounts/${accountId}/signers/${tenantContactId}/documents`),
    };

    return res.status(200).json({ accountId, tenantContactId, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
