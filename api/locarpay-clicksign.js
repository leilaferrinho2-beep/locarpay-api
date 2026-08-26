// POST /api/locarpay-clicksign
// Gerencia contratos via Clicksign: envio para assinatura, consulta de status e download do PDF assinado.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const CLICKSIGN_BASE = process.env.CLICKSIGN_BASE_URL || 'https://sandbox.clicksign.com/api/v1';
const FB_PROJECT     = 'locarpayapp';
const BUCKET         = `${FB_PROJECT}.appspot.com`;

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({
    credential: cert(JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT)),
    storageBucket: BUCKET
  });
}

function token() {
  const t = process.env.CLICKSIGN_ACCESS_TOKEN;
  if (!t) throw new Error('CLICKSIGN_ACCESS_TOKEN não configurado');
  return t;
}

async function csRequest(method, path, body) {
  const url = `${CLICKSIGN_BASE}${path}?access_token=${token()}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const msg = json?.errors?.join(', ') || json?.message || text || `HTTP ${r.status}`;
    throw new Error(`Clicksign ${method} ${path}: ${msg}`);
  }
  return json;
}

// ── Cria ou reutiliza signatário ─────────────────────────────────────────────
async function getOrCreateSigner(name, email, phone) {
  const signer = {
    email,
    auths: ['email'],
    name,
    has_documentation: false
  };
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10) signer.phone_number = `+55${digits.replace(/^55/, '')}`;
  }
  const resp = await csRequest('POST', '/signers', { signer });
  return resp.signer?.key;
}

// ── Adiciona signatário ao documento ─────────────────────────────────────────
async function addSignerToDocument(documentKey, signerKey, message, refusalEnabled = false) {
  const resp = await csRequest('POST', '/lists', {
    list: {
      document_key: documentKey,
      signer_key: signerKey,
      sign_as: 'sign',
      message: message || undefined,
      refusal_enabled: refusalEnabled
    }
  });
  return resp.list;
}

// ── Envia documento para assinatura ──────────────────────────────────────────
async function finishDocument(documentKey) {
  await csRequest('PATCH', `/documents/${documentKey}/finish`, {});
}

// ── Consulta status do documento ──────────────────────────────────────────────
async function getDocumentStatus(documentKey) {
  const resp = await csRequest('GET', `/documents/${documentKey}`, null);
  return resp.document;
}

// ── Passo: send ───────────────────────────────────────────────────────────────
async function handleSend(db, body) {
  const {
    contractId,
    pdfBase64,
    ownerName, ownerEmail, ownerPhone,
    tenantName, tenantEmail, tenantPhone,
    fiadorName, fiadorEmail,
    propertyDescription,
    ownerId
  } = body;

  if (!contractId || !pdfBase64) throw new Error('contractId e pdfBase64 são obrigatórios');

  const fileName = `contrato_${contractId}_${Date.now()}.pdf`;
  const contentBase64 = pdfBase64.startsWith('data:')
    ? pdfBase64
    : `data:application/pdf;base64,${pdfBase64}`;

  // 1. Upload do documento
  const docResp = await csRequest('POST', '/documents', {
    document: {
      path: `/contratos/${fileName}`,
      content_base64: contentBase64,
      deadline_at: null,
      auto_close: true,
      locale: 'pt-BR',
      sequence_enabled: true
    }
  });
  const documentKey = docResp.document?.key;
  if (!documentKey) throw new Error('Clicksign não retornou document.key');

  // 2. Cria signatários
  const msg = `Por favor, assine o contrato de locação do imóvel: ${propertyDescription || 'imóvel'}.`;
  const ownerKey  = await getOrCreateSigner(ownerName,  ownerEmail,  ownerPhone);
  const tenantKey = await getOrCreateSigner(tenantName, tenantEmail, tenantPhone);

  // 3. Adiciona ao documento (sequencial: proprietário primeiro)
  await addSignerToDocument(documentKey, ownerKey,  msg);
  await addSignerToDocument(documentKey, tenantKey, msg);

  if (fiadorEmail && fiadorName) {
    const fiadorKey = await getOrCreateSigner(fiadorName, fiadorEmail);
    await addSignerToDocument(documentKey, fiadorKey, msg);
  }

  // 4. Envia para assinatura
  await finishDocument(documentKey);

  // 5. Salva no Firestore
  const updates = {
    clicksignDocumentKey: documentKey,
    clicksignStatus: 'running',
    contractSentAt: FieldValue.serverTimestamp(),
    ownerSigned: false,
    bothSigned: false
  };
  await db.collection('contracts').doc(contractId).update(updates);

  console.log(`[clicksign] contrato ${contractId} enviado — documentKey: ${documentKey}`);
  return { ok: true, documentKey };
}

// ── Passo: status ─────────────────────────────────────────────────────────────
async function handleStatus(db, body) {
  const { contractId, documentKey } = body;
  if (!documentKey) throw new Error('documentKey é obrigatório');

  const doc = await getDocumentStatus(documentKey);
  const status = doc?.status || 'unknown';
  const signedFileUrl = doc?.downloads?.signed_file_url || null;

  const updates = { clicksignStatus: status, updatedAt: FieldValue.serverTimestamp() };
  if (signedFileUrl) updates.signedFileUrl = signedFileUrl;

  if (contractId) await db.collection('contracts').doc(contractId).update(updates);

  return { status, signedFileUrl };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initAdmin();
    const db = getFirestore();
    const { step } = req.body || {};

    if (step === 'send')   return res.status(200).json(await handleSend(db, req.body));
    if (step === 'status') return res.status(200).json(await handleStatus(db, req.body));

    return res.status(400).json({ error: `step inválido: ${step}` });
  } catch (e) {
    console.error('[locarpay-clicksign] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
