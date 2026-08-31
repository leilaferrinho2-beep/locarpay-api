// POST /api/ilocarpay-fix-contract  { contractId, tenantEmail }
// POST /api/ilocarpay-fix-contract  { step:'set-owner-signed', contractId }
// POST /api/ilocarpay-fix-contract  { step:'reassign', contractId, documentId, ownerEmail, ... }
// GET  /api/ilocarpay-fix-contract?contractId=xxx  → proxia PDF via Assinafy
// (/api/ilocarpay-reassign-contract redirecionado aqui via vercel rewrite)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

function initFirebase() {
  if (!getApps().length) initializeApp({
    credential: cert(JSON.parse(process.env.ILOCARPAY_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT)),
    storageBucket: BUCKET
  });
}

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.ILOCARPAY_FIREBASE_API_KEY || process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const ASSINAFY   = 'https://api.assinafy.com.br/v1';
const BUCKET     = `${FB_PROJECT}.appspot.com`;

async function fsGet(path) {
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}`);
  if (!r.ok) throw new Error(`Firestore GET ${path}: ${r.status}`);
  return r.json();
}

async function fsPatch(path, fields) {
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}&${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${path}: ${await r.text()}`);
  return r.json();
}

async function assinafyGet(apiKey, path) {
  const r = await fetch(`${ASSINAFY}/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function assinafyPost(apiKey, path, body) {
  const r = await fetch(`${ASSINAFY}/${path}`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

async function getOrCreateContact(apiKey, accountId, name, email) {
  const signers  = await assinafyGet(apiKey, `accounts/${accountId}/signers`);
  const existing = (signers?.data || []).find(s => s.email?.toLowerCase() === email.toLowerCase());
  if (existing) return existing.id;
  const resp = await assinafyPost(apiKey, `accounts/${accountId}/signers`, { full_name: name, email });
  return resp.data?.data?.id || resp.data?.id;
}

async function handleSetOwnerSigned(req, res) {
  const { contractId, completed } = req.body || {};
  if (!contractId) return res.status(400).json({ error: 'contractId obrigatório' });
  const fields = { ownerSigned: { booleanValue: true } };
  if (completed) fields.assinafyStatus = { stringValue: 'completed' };
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const r = await fetch(
    `${FS_BASE}/contracts/${contractId}?key=${FB_API_KEY}&${mask}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }
  );
  if (!r.ok) return res.status(500).json({ error: await r.text() });
  return res.status(200).json({ ok: true, contractId });
}

async function handleGetContractPdf(req, res) {
  const { contractId } = req.query;
  if (!contractId) return res.status(400).json({ error: 'contractId obrigatório' });
  initFirebase();
  const db = getFirestore();
  const contractSnap = await db.collection('contracts').doc(contractId).get();
  if (!contractSnap.exists) return res.status(404).json({ error: 'Contrato não encontrado' });
  const contract = contractSnap.data();

  // ── Caminho 1: PDF arquivado no Firebase Storage — gera presigned URL (15 min) ─
  if (contract.signedStoragePath) {
    try {
      const bucket = getStorage().bucket();
      const file   = bucket.file(contract.signedStoragePath);
      const [exists] = await file.exists();
      if (exists) {
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutos
        const [presignedUrl] = await file.getSignedUrl({
          action:  'read',
          expires: expiresAt,
          responseDisposition: 'attachment; filename="contrato_assinado.pdf"',
          responseType: 'application/pdf'
        });
        // Redireciona para a presigned URL — o app segue o redirect automaticamente
        return res.redirect(302, presignedUrl);
      }
    } catch (e) {
      console.warn(`[fix-contract] falha ao gerar presigned URL: ${e.message}`);
      // Continua para fallback
    }
  }

  // ── Caminho 2: fallback — proxia PDF direto do Assinafy ─────────────────────
  const configSnap = await db.collection('config').doc('assinafy').get();
  const apiKey = configSnap.data()?.apiKey;
  if (!apiKey) return res.status(500).json({ error: 'Configuração Assinafy não encontrada' });

  let signedUrl = contract.signedFileUrl || null;
  if (!signedUrl) {
    const assinafyDocId = contract.assinafyDocumentId;
    if (!assinafyDocId) return res.status(404).json({ error: 'Contrato ainda não enviado para assinatura' });
    try {
      const docRes    = await assinafyGet(apiKey, `documents/${assinafyDocId}`);
      const artifacts = docRes.data?.artifacts;
      signedUrl       = artifacts?.certificated || artifacts?.bundle || artifacts?.original || null;
    } catch (_) {}
    if (!signedUrl) return res.status(404).json({ error: 'Contrato assinado não encontrado' });
    await db.collection('contracts').doc(contractId).update({ signedFileUrl: signedUrl });
  }

  const pdfResp = await fetch(signedUrl, { headers: { 'X-Api-Key': apiKey, 'Accept': 'application/pdf,*/*' } });
  if (!pdfResp.ok) {
    if (pdfResp.status === 401 || pdfResp.status === 403)
      await db.collection('contracts').doc(contractId).update({ signedFileUrl: '' });
    return res.status(502).json({ error: `Erro ao baixar PDF: HTTP ${pdfResp.status}` });
  }
  const bytes = Buffer.from(await pdfResp.arrayBuffer());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="contrato_assinado.pdf"');
  res.setHeader('Content-Length', bytes.length);
  return res.status(200).send(bytes);
}

async function handleReassign(req, res) {
  const { contractId, documentId, ownerEmail, ownerName, tenantEmail, tenantName, propertyDescription } = req.body || {};
  if (!contractId || !documentId || !ownerEmail || !tenantEmail)
    return res.status(400).json({ error: 'contractId, documentId, ownerEmail e tenantEmail são obrigatórios' });

  const configDoc = await fsGet('config/assinafy');
  const apiKey    = configDoc?.fields?.apiKey?.stringValue;
  if (!apiKey) return res.status(500).json({ error: 'API key Assinafy não configurada' });

  const accountsResp = await assinafyGet(apiKey, 'accounts');
  const accountId    = accountsResp?.data?.[0]?.id;
  if (!accountId) return res.status(500).json({ error: 'Conta Assinafy não encontrada' });

  const ownerContactId  = await getOrCreateContact(apiKey, accountId, ownerName  || ownerEmail,  ownerEmail);
  const tenantContactId = await getOrCreateContact(apiKey, accountId, tenantName || tenantEmail, tenantEmail);
  if (!ownerContactId || !tenantContactId)
    return res.status(500).json({ error: 'Não foi possível obter IDs dos signatários' });

  const assignmentResp = await assinafyPost(apiKey, `documents/${documentId}/assignments`, {
    method: 'virtual',
    message: propertyDescription
      ? `Por favor, assine o contrato de locação do imóvel ${propertyDescription}.`
      : 'Por favor, assine o contrato de locação.',
    signers: [
      { id: ownerContactId,  verification_method: 'Email', notification_methods: ['Email'], step: 1 },
      { id: tenantContactId, verification_method: 'Email', notification_methods: ['Email'], step: 2 }
    ]
  });

  let assignmentId = assignmentResp.data?.data?.id || assignmentResp.data?.id || assignmentResp.data?.assignment?.id;
  if (!assignmentId) {
    const listResp = await assinafyGet(apiKey, `accounts/${accountId}/documents/${documentId}/assignments`);
    assignmentId   = listResp?.data?.[0]?.id || listResp?.data?.id;
  }
  if (!assignmentId) return res.status(500).json({ error: 'Não foi possível criar assignment' });

  await fsPatch(`contracts/${contractId}`, {
    assinafyDocumentId:   { stringValue: documentId },
    assinafyAssignmentId: { stringValue: assignmentId },
    assinafyStatus:       { stringValue: 'pending' }
  });
  return res.status(200).json({ ok: true, documentId, assignmentId });
}

async function handleFixContract(req, res) {
  const { contractId, tenantEmail } = req.body || {};
  if (!contractId || !tenantEmail) return res.status(400).json({ error: 'contractId e tenantEmail obrigatórios' });

  const configDoc = await fsGet('config/assinafy');
  const apiKey    = configDoc?.fields?.apiKey?.stringValue;
  if (!apiKey) return res.status(500).json({ error: 'API key Assinafy não configurada' });

  const accountsResp = await assinafyGet(apiKey, 'accounts');
  const accountId    = accountsResp?.data?.[0]?.id;
  if (!accountId) return res.status(500).json({ error: 'Conta Assinafy não encontrada' });

  const docsResp = await assinafyGet(apiKey, `accounts/${accountId}/documents?per_page=50`);
  const docs     = docsResp?.data || [];

  let foundDocId = null, foundAssignmentId = null;
  for (const doc of docs) {
    try {
      const assignmentsResp = await assinafyGet(apiKey, `documents/${doc.id}/assignments`);
      for (const assignment of (assignmentsResp?.data || [])) {
        const detail  = await assinafyGet(apiKey, `documents/${doc.id}/assignments/${assignment.id}`);
        const signers = detail?.data?.signers || [];
        if (signers.some(s => s.email?.toLowerCase() === tenantEmail.toLowerCase())) {
          foundDocId = doc.id; foundAssignmentId = assignment.id; break;
        }
      }
      if (foundDocId) break;
    } catch (_) {}
  }

  if (!foundDocId) return res.status(404).json({ error: `Documento não encontrado para ${tenantEmail}` });

  await fsPatch(`contracts/${contractId}`, {
    assinafyDocumentId:   { stringValue: foundDocId },
    assinafyAssignmentId: { stringValue: foundAssignmentId },
    assinafyStatus:       { stringValue: 'pending' }
  });
  return res.status(200).json({ ok: true, assinafyDocumentId: foundDocId, assinafyAssignmentId: foundAssignmentId });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return handleGetContractPdf(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { step } = req.body || {};
    if (step === 'set-owner-signed') return handleSetOwnerSigned(req, res);
    if (step === 'reassign')         return handleReassign(req, res);
    return handleFixContract(req, res);
  } catch(e) {
    console.error('fix-contract error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
