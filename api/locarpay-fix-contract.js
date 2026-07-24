// POST /api/locarpay-fix-contract  { contractId, tenantEmail }
// Busca na Assinafy o documento/assignment do inquilino e atualiza o Firestore

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

async function fsGet(path) {
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}`);
  if (!r.ok) throw new Error(`Firestore GET ${path}: ${r.status}`);
  return r.json();
}

async function fsPatch(path, fields) {
  const updateMask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}&${updateMask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${path}: ${await r.text()}`);
  return r.json();
}

async function assinafyGet(apiKey, path) {
  const r = await fetch(`https://app.assinafy.com.br/api/v1/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`Assinafy GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contractId, tenantEmail } = req.body || {};
  if (!contractId || !tenantEmail) return res.status(400).json({ error: 'contractId e tenantEmail obrigatórios' });

  try {
    // 1. Busca a API key da Assinafy no Firestore
    const configDoc = await fsGet('config/assinafy');
    const apiKey = configDoc?.fields?.apiKey?.stringValue;
    if (!apiKey) return res.status(500).json({ error: 'API key Assinafy não configurada' });

    // 2. Busca a conta
    const accountsResp = await assinafyGet(apiKey, 'accounts');
    const accountId = accountsResp?.data?.[0]?.id;
    if (!accountId) return res.status(500).json({ error: 'Conta Assinafy não encontrada' });

    // 3. Lista documentos e procura o do inquilino (pelo e-mail nos assignments)
    const docsResp = await assinafyGet(apiKey, `accounts/${accountId}/documents?per_page=50`);
    const docs = docsResp?.data || [];

    let foundDocId = null;
    let foundAssignmentId = null;

    for (const doc of docs) {
      try {
        const assignmentsResp = await assinafyGet(apiKey, `documents/${doc.id}/assignments`);
        const assignments = assignmentsResp?.data || [];
        for (const assignment of assignments) {
          const assignmentDetail = await assinafyGet(apiKey, `documents/${doc.id}/assignments/${assignment.id}`);
          const signers = assignmentDetail?.data?.signers || [];
          const hasTenant = signers.some(s => s.email?.toLowerCase() === tenantEmail.toLowerCase());
          if (hasTenant) {
            foundDocId = doc.id;
            foundAssignmentId = assignment.id;
            break;
          }
        }
        if (foundDocId) break;
      } catch (_) {}
    }

    if (!foundDocId || !foundAssignmentId) {
      return res.status(404).json({ error: `Documento não encontrado na Assinafy para ${tenantEmail}` });
    }

    // 4. Atualiza o contrato no Firestore
    await fsPatch(`contracts/${contractId}`, {
      assinafyDocumentId: { stringValue: foundDocId },
      assinafyAssignmentId: { stringValue: foundAssignmentId },
      assinafyStatus: { stringValue: 'pending' }
    });

    return res.status(200).json({
      ok: true,
      assinafyDocumentId: foundDocId,
      assinafyAssignmentId: foundAssignmentId
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
