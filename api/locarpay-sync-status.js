// POST /api/locarpay-sync-status  { tenantEmail }
// Consulta Assinafy, detecta ownerSigned e atualiza Firestore

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

async function fsQuery(collectionId, field, value) {
  const r = await fetch(`${FS_BASE}:runQuery?key=${FB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
        limit: 1
      }
    })
  });
  const rows = await r.json();
  return rows.find(row => row.document)?.document || null;
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

async function assinafyGet(apiKey, path) {
  const r = await fetch(`https://api.assinafy.com.br/v1/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const SIGNED_STATUSES = ['signed', 'completed', 'approved', 'finished', 'done'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tenantEmail } = req.body || {};
  if (!tenantEmail) return res.status(400).json({ error: 'tenantEmail obrigatório' });

  try {
    // 1. API key Assinafy
    const configSnap = await fetch(`${FS_BASE}/config/assinafy?key=${FB_API_KEY}`).then(r => r.json());
    const apiKey = configSnap?.fields?.apiKey?.stringValue;
    if (!apiKey) return res.status(500).json({ error: 'API key Assinafy não configurada' });

    // 2. Contrato no Firestore
    const contractDoc = await fsQuery('contracts', 'tenantEmail', tenantEmail);
    if (!contractDoc) return res.status(404).json({ error: 'Contrato não encontrado' });

    const contractId = contractDoc.name.split('/').pop();
    const fields = contractDoc.fields || {};
    const assinafyDocumentId = fields.assinafyDocumentId?.stringValue || '';
    const assinafyAssignmentId = fields.assinafyAssignmentId?.stringValue || '';
    const currentOwnerSigned = fields.ownerSigned?.booleanValue || false;

    const result = { contractId, assinafyDocumentId, assinafyAssignmentId, currentOwnerSigned };

    if (!assinafyDocumentId || !assinafyAssignmentId) {
      return res.status(200).json({ ...result, error: 'IDs Assinafy não preenchidos no contrato' });
    }

    // 3. Consulta assignment na Assinafy
    const assignResp = await assinafyGet(apiKey, `documents/${assinafyDocumentId}/assignments/${assinafyAssignmentId}`);
    const signers = assignResp?.data?.signers || [];

    result.rawAssignResp = assignResp;
    result.signers = signers.map(s => ({ email: s.email, status: s.status, step: s.step }));

    const tenantEmailLc = tenantEmail.toLowerCase();
    const ownerSigner = signers.find(s => s.email?.toLowerCase() !== tenantEmailLc);
    const ownerSignedApi = SIGNED_STATUSES.includes(ownerSigner?.status?.toLowerCase() || '');

    result.ownerSignerStatus = ownerSigner?.status;
    result.ownerSignedApi = ownerSignedApi;

    // 4. Atualiza Firestore se necessário
    if (ownerSignedApi && !currentOwnerSigned) {
      await fsPatch(`contracts/${contractId}`, { ownerSigned: { booleanValue: true } });
      result.updated = true;
    } else {
      result.updated = false;
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
