// POST /api/locarpay-reassign-contract
// { contractId, documentId, ownerEmail, ownerName, tenantEmail, tenantName, propertyDescription }
// Cria novo assignment no documento Assinafy existente e salva IDs no Firestore

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const ASSINAFY_BASE = 'https://api.assinafy.com.br/v1';

async function fsGet(path) {
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}`);
  if (!r.ok) throw new Error(`Firestore GET: ${r.status}`);
  return r.json();
}

async function fsPatch(path, fields) {
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}&${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`Firestore PATCH: ${await r.text()}`);
  return r.json();
}

async function assinafyPost(apiKey, path, body) {
  const r = await fetch(`${ASSINAFY_BASE}/${path}`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

async function assinafyGet(apiKey, path) {
  const r = await fetch(`${ASSINAFY_BASE}/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function getOrCreateContact(apiKey, accountId, name, email) {
  const signers = await assinafyGet(apiKey, `accounts/${accountId}/signers`);
  const existing = (signers?.data || []).find(s => s.email?.toLowerCase() === email.toLowerCase());
  if (existing) return existing.id;
  const resp = await assinafyPost(apiKey, `accounts/${accountId}/signers`, { full_name: name, email });
  return resp.data?.data?.id || resp.data?.id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contractId, documentId, ownerEmail, ownerName, tenantEmail, tenantName, propertyDescription } = req.body || {};
  if (!contractId || !documentId || !ownerEmail || !tenantEmail) {
    return res.status(400).json({ error: 'contractId, documentId, ownerEmail e tenantEmail são obrigatórios' });
  }

  try {
    const configDoc = await fsGet('config/assinafy');
    const apiKey = configDoc?.fields?.apiKey?.stringValue;
    if (!apiKey) return res.status(500).json({ error: 'API key Assinafy não configurada' });

    const accountsResp = await assinafyGet(apiKey, 'accounts');
    const accountId = accountsResp?.data?.[0]?.id;
    if (!accountId) return res.status(500).json({ error: 'Conta Assinafy não encontrada' });

    const ownerContactId = await getOrCreateContact(apiKey, accountId, ownerName || ownerEmail, ownerEmail);
    const tenantContactId = await getOrCreateContact(apiKey, accountId, tenantName || tenantEmail, tenantEmail);

    if (!ownerContactId || !tenantContactId) {
      return res.status(500).json({ error: 'Não foi possível obter IDs dos signatários', ownerContactId, tenantContactId });
    }

    const assignmentResp = await assinafyPost(apiKey, `documents/${documentId}/assignments`, {
      method: 'virtual',
      message: propertyDescription ? `Por favor, assine o contrato de locação do imóvel ${propertyDescription}.` : 'Por favor, assine o contrato de locação.',
      signers: [
        { id: ownerContactId, verification_method: 'Email', notification_methods: ['Email'], step: 1 },
        { id: tenantContactId, verification_method: 'Email', notification_methods: ['Email'], step: 2 }
      ]
    });

    const assignmentId = assignmentResp.data?.data?.id || assignmentResp.data?.id;
    if (!assignmentId) {
      return res.status(500).json({ error: 'Não foi possível criar assignment', assignmentResp });
    }

    await fsPatch(`contracts/${contractId}`, {
      assinafyDocumentId: { stringValue: documentId },
      assinafyAssignmentId: { stringValue: assignmentId },
      assinafyStatus: { stringValue: 'pending' }
    });

    return res.status(200).json({ ok: true, documentId, assignmentId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
