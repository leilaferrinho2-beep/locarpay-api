// POST /api/locarpay-fix-contract  { contractId, tenantEmail }
// GET  /api/locarpay-fix-contract?contractId=xxx  → proxia PDF do contrato via Assinafy

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initFirebase() {
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

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
  const r = await fetch(`https://api.assinafy.com.br/v1/${path}`, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`Assinafy GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function handleSetOwnerSigned(req, res) {
  const { contractId, completed } = req.body || {};
  if (!contractId) return res.status(400).json({ error: 'contractId obrigatório' });
  try {
    const fields = { ownerSigned: { booleanValue: true } };
    if (completed) fields.assinafyStatus = { stringValue: 'completed' };
    const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
    const r = await fetch(
      `${FS_BASE}/contracts/${contractId}?key=${FB_API_KEY}&${mask}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }
    );
    if (!r.ok) throw new Error(await r.text());
    return res.status(200).json({ ok: true, contractId, fields: Object.keys(fields) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// GET /api/locarpay-fix-contract?contractId=xxx
// Baixa o PDF do contrato via backend (proxied) — API key da Assinafy nunca vai ao cliente
async function handleGetContractPdf(req, res) {
  const { contractId } = req.query;
  if (!contractId) return res.status(400).json({ error: 'contractId obrigatório' });
  try {
    initFirebase();
    const db = getFirestore();

    const contractSnap = await db.collection('contracts').doc(contractId).get();
    if (!contractSnap.exists) return res.status(404).json({ error: 'Contrato não encontrado' });
    const contract = contractSnap.data();

    const configSnap = await db.collection('config').doc('assinafy').get();
    const apiKey = configSnap.data()?.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'Configuração Assinafy não encontrada' });

    // Resolve signed URL (usa cache ou busca na Assinafy)
    let signedUrl = contract.signedFileUrl || null;

    if (!signedUrl) {
      const assinafyDocId = contract.assinafyDocumentId;
      if (!assinafyDocId) return res.status(404).json({ error: 'Contrato ainda não enviado para assinatura digital' });

      const accounts = await assinafyGet(apiKey, 'accounts');
      const accountId = accounts.data?.[0]?.id;
      if (!accountId) return res.status(500).json({ error: 'Conta Assinafy não encontrada' });

      try {
        const docRes = await assinafyGet(apiKey, `accounts/${accountId}/documents/${assinafyDocId}`);
        signedUrl = docRes.data?.signed_url || docRes.data?.signedUrl || null;
      } catch (_) {}

      if (!signedUrl) {
        const listRes = await assinafyGet(apiKey, `accounts/${accountId}/documents`);
        const found = (listRes.data || []).find(d =>
          (d.is_certificated || d.isCertificated) && (d.signed_url || d.signedUrl)
        );
        if (found) signedUrl = found.signed_url || found.signedUrl;
      }

      if (!signedUrl) return res.status(404).json({ error: 'Contrato assinado não encontrado na Assinafy' });

      await db.collection('contracts').doc(contractId).update({ signedFileUrl: signedUrl });
    }

    // Proxia o PDF com autenticação — API key nunca sai do servidor
    const pdfResp = await fetch(signedUrl, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/pdf,*/*' }
    });

    if (!pdfResp.ok) {
      if (pdfResp.status === 401 || pdfResp.status === 403) {
        // URL expirou — limpa cache para forçar nova busca
        await db.collection('contracts').doc(contractId).update({ signedFileUrl: '' });
      }
      return res.status(502).json({ error: `Erro ao baixar PDF: HTTP ${pdfResp.status}` });
    }

    const bytes = Buffer.from(await pdfResp.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="contrato_assinado.pdf"');
    res.setHeader('Content-Length', bytes.length);
    return res.status(200).send(bytes);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return handleGetContractPdf(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Roteamento por step (set-owner-signed foi absorvido aqui)
  if (req.body?.step === 'set-owner-signed') return handleSetOwnerSigned(req, res);

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
