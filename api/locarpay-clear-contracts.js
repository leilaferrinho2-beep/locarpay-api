// Endpoint TEMPORÁRIO — apagar após uso
// POST /api/locarpay-clear-contracts  { "secret": "lp-clear-2026" }

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

async function listDocs(collection) {
  const url = `${FS_BASE}/${collection}?key=${FB_API_KEY}&pageSize=300`;
  const resp = await fetch(url);
  const json = await resp.json();
  return json.documents || [];
}

async function deleteDoc(name) {
  const url = `https://firestore.googleapis.com/v1/${name}?key=${FB_API_KEY}`;
  const resp = await fetch(url, { method: 'DELETE' });
  return resp.ok;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { secret } = req.body || {};
  if (secret !== 'lp-clear-2026') return res.status(403).json({ error: 'Acesso negado' });

  try {
    const docs = await listDocs('contracts');
    const results = await Promise.all(docs.map(d => deleteDoc(d.name)));
    const deleted = results.filter(Boolean).length;
    res.status(200).json({ deleted, total: docs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
