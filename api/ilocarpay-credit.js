// POST /api/ilocarpay-credit
// Consulta de crédito (Serasa Experian + Boa Vista SCPC) por imobiliária
// step:"check-serasa"       → { ownerId, tenantId, cpf }
// step:"check-boavista"     → { ownerId, tenantId, cpf }
// step:"save-credentials"   → { ownerId, bureau, clientId, clientSecret }

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

// ── URLs das APIs ─────────────────────────────────────────────────────────────
const SERASA = {
  tokenUrl:  'https://api.serasaexperian.com.br/security/iam/v1/consumer-tokens',
  reportUrl: 'https://api.serasaexperian.com.br/search/v1/documents'
};
const BOAVISTA = {
  tokenUrl:  'https://api.boavistaservicos.com.br/auth/oauth/v2/token',
  reportUrl: 'https://api.boavistaservicos.com.br/consumidor/v1/relatorio'
};

// ── Sandbox ───────────────────────────────────────────────────────────────────
function sandboxReport(cpf, bureau) {
  const seed   = cpf.replace(/\D/g, '').split('').reduce((a, d) => a + +d, 0);
  const score  = 300 + ((seed * (bureau === 'boavista' ? 61 : 73)) % 600);
  const status = score >= 600 ? 'REGULAR' : score >= 400 ? 'IRREGULAR' : 'NEGATIVADO';
  return {
    sandbox: true,
    bureau,
    cpf,
    score,
    status,
    statusLabel: status === 'REGULAR' ? 'Regular' : status === 'IRREGULAR' ? 'Irregular' : 'Negativado',
    pendencias: status !== 'REGULAR' ? [
      { tipo: 'Dívida bancária', valor: 1200 + seed * 10, dataOcorrencia: '2024-03-15', credor: 'Banco Exemplo S.A.' },
      { tipo: 'Protesto',        valor: 450,               dataOcorrencia: '2023-11-02', credor: 'Empresa Demo Ltda.' }
    ] : [],
    consultadoEm: new Date().toISOString()
  };
}

// ── Serasa ────────────────────────────────────────────────────────────────────
async function getSerasaToken(clientId, clientSecret) {
  const r = await fetch(SERASA.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret })
  });
  if (!r.ok) throw new Error(`Serasa auth ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.accessToken || d.access_token;
}

async function querySerasa(cpf, token) {
  const r = await fetch(`${SERASA.reportUrl}/${cpf}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error(`Serasa query ${r.status}: ${await r.text()}`);
  return r.json();
}

function parseSerasa(raw, cpf) {
  const score  = raw?.score?.score ?? raw?.score ?? null;
  const status = raw?.optIn?.situacao ?? raw?.situacao ?? (score >= 600 ? 'REGULAR' : 'IRREGULAR');
  const pendencias = (raw?.negativacoes || raw?.pendencias || []).map(p => ({
    tipo: p.tipoRegistro || p.tipo || '—',
    valor: p.valorTotal  || p.valor || 0,
    dataOcorrencia: p.dataOcorrencia || '—',
    credor: p.nomeCredor || p.credor || '—'
  }));
  return {
    sandbox: false, bureau: 'serasa', cpf, score, status,
    statusLabel: status === 'REGULAR' ? 'Regular' : status === 'IRREGULAR' ? 'Irregular' : 'Negativado',
    pendencias, consultadoEm: new Date().toISOString()
  };
}

// ── Boa Vista SCPC ────────────────────────────────────────────────────────────
async function getBoaVistaToken(clientId, clientSecret) {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
  const r = await fetch(BOAVISTA.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!r.ok) throw new Error(`Boa Vista auth ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.access_token;
}

async function queryBoaVista(cpf, token) {
  const r = await fetch(`${BOAVISTA.reportUrl}/${cpf}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error(`Boa Vista query ${r.status}: ${await r.text()}`);
  return r.json();
}

function parseBoaVista(raw, cpf) {
  const score  = raw?.score?.pontuation ?? raw?.score ?? null;
  const ocorrencias = raw?.ocorrencias || raw?.pendencias || [];
  const status = ocorrencias.length === 0 ? 'REGULAR' : 'NEGATIVADO';
  const pendencias = ocorrencias.map(p => ({
    tipo: p.tipoOcorrencia || p.tipo || '—',
    valor: p.valor || 0,
    dataOcorrencia: p.dataOcorrencia || '—',
    credor: p.nomeCredor || p.credor || '—'
  }));
  return {
    sandbox: false, bureau: 'boavista', cpf, score, status,
    statusLabel: status === 'REGULAR' ? 'Regular' : 'Negativado',
    pendencias, consultadoEm: new Date().toISOString()
  };
}

// ── HANDLERS ──────────────────────────────────────────────────────────────────

async function handleCheck(db, body, bureau) {
  const { ownerId, tenantId, cpf } = body;
  if (!ownerId || !tenantId || !cpf) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const cpfD = cpf.replace(/\D/g, '');
  if (cpfD.length !== 11) throw Object.assign(new Error('CPF inválido'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });
  const owner = ownerSnap.data();

  if (!owner.creditAnalysisEnabled) throw Object.assign(new Error('Módulo de análise não ativo'), { status: 403 });

  let report;
  if (bureau === 'serasa') {
    const cid = owner.serasaClientId     || '';
    const csc = owner.serasaClientSecret || '';
    if (!cid || !csc || cid.startsWith('sandbox')) {
      report = sandboxReport(cpfD, 'serasa');
    } else {
      const token = await getSerasaToken(cid, csc);
      const raw   = await querySerasa(cpfD, token);
      report = parseSerasa(raw, cpfD);
    }
    await db.collection('users').doc(tenantId).update({
      'creditAnalysis.serasaReport':    report,
      'creditAnalysis.serasaCheckedAt': FieldValue.serverTimestamp(),
      'creditAnalysis.score':           report.score,
      'creditAnalysis.status': report.status === 'REGULAR' ? 'approved' : 'analyzing',
      updatedAt: FieldValue.serverTimestamp()
    });
  } else {
    const cid = owner.boavistaClientId     || '';
    const csc = owner.boavistaClientSecret || '';
    if (!cid || !csc || cid.startsWith('sandbox')) {
      report = sandboxReport(cpfD, 'boavista');
    } else {
      const token = await getBoaVistaToken(cid, csc);
      const raw   = await queryBoaVista(cpfD, token);
      report = parseBoaVista(raw, cpfD);
    }
    await db.collection('users').doc(tenantId).update({
      'creditAnalysis.boavistaReport':    report,
      'creditAnalysis.boavistaCheckedAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  return report;
}

async function handleSaveCredentials(db, body, callerEmail) {
  const { ownerId, bureau, clientId, clientSecret } = body;
  if (!ownerId || !bureau) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });
  const owner = ownerSnap.data();

  const MASTER = process.env.MASTER_EMAIL || 'contatotransgu@gmail.com';
  if (callerEmail !== MASTER && owner.email !== callerEmail)
    throw Object.assign(new Error('Sem permissão'), { status: 403 });

  const fields = bureau === 'serasa'
    ? { serasaClientId: clientId || '',     serasaClientSecret: clientSecret || '' }
    : { boavistaClientId: clientId || '',   boavistaClientSecret: clientSecret || '' };

  await db.collection('owners').doc(ownerId).update({ ...fields, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db  = getFirestore();
    const { step, callerEmail } = req.body || {};

    let result;
    if      (step === 'check-serasa')      result = await handleCheck(db, req.body, 'serasa');
    else if (step === 'check-boavista')    result = await handleCheck(db, req.body, 'boavista');
    else if (step === 'save-credentials')  result = await handleSaveCredentials(db, req.body, callerEmail);
    else throw Object.assign(new Error('step inválido'), { status: 400 });

    res.status(200).json(result);
  } catch (e) {
    console.error('[ilocarpay-credit]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
}
