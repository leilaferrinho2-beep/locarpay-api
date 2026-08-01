// POST /api/locarpay-credit
// Consulta de crédito Serasa Experian por imobiliária
// step:"check"  → { ownerId, tenantId, cpf } → consulta Serasa com credenciais da imobiliária
// step:"save-credentials" → { ownerId, clientId, clientSecret } → salva credenciais (master only)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

const SERASA_TOKEN_URL  = 'https://api.serasaexperian.com.br/security/iam/v1/consumer-tokens';
const SERASA_REPORT_URL = 'https://api.serasaexperian.com.br/search/v1/documents';

// Dados sandbox — retornados quando credenciais não estão configuradas ou começam com "sandbox"
function sandboxReport(cpf) {
  const seed = cpf.replace(/\D/g, '').split('').reduce((a, d) => a + +d, 0);
  const score = 300 + ((seed * 73) % 600);
  const status = score >= 600 ? 'REGULAR' : score >= 400 ? 'IRREGULAR' : 'NEGATIVADO';
  return {
    sandbox: true,
    cpf,
    score,
    status,
    statusLabel: status === 'REGULAR' ? 'Regular' : status === 'IRREGULAR' ? 'Irregular' : 'Negativado',
    pendencias: status !== 'REGULAR' ? [
      { tipo: 'Dívida bancária', valor: 1200.00 + seed * 10, dataOcorrencia: '2024-03-15', credor: 'Banco Exemplo S.A.' },
      { tipo: 'Protesto',        valor: 450.00,               dataOcorrencia: '2023-11-02', credor: 'Empresa Demo Ltda.' }
    ] : [],
    consultadoEm: new Date().toISOString()
  };
}

async function getSerasaToken(clientId, clientSecret) {
  const r = await fetch(SERASA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Serasa auth error ${r.status}: ${txt}`);
  }
  const data = await r.json();
  return data.accessToken || data.access_token;
}

async function querySerasa(cpf, token) {
  const cpfD = cpf.replace(/\D/g, '');
  const r = await fetch(`${SERASA_REPORT_URL}/${cpfD}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Serasa query error ${r.status}: ${txt}`);
  }
  return r.json();
}

function parseSerasaResponse(raw, cpf) {
  // Normaliza resposta da Serasa para formato interno
  const score  = raw?.score?.score ?? raw?.score ?? null;
  const status = raw?.optIn?.situacao ?? raw?.situacao ?? (score >= 600 ? 'REGULAR' : 'IRREGULAR');
  const pendencias = (raw?.negativacoes || raw?.pendencias || []).map(p => ({
    tipo:           p.tipoRegistro || p.tipo || '—',
    valor:          p.valorTotal   || p.valor || 0,
    dataOcorrencia: p.dataOcorrencia || '—',
    credor:         p.nomeCredor   || p.credor || '—'
  }));
  return {
    sandbox: false,
    cpf,
    score,
    status,
    statusLabel: status === 'REGULAR' ? 'Regular' : status === 'IRREGULAR' ? 'Irregular' : 'Negativado',
    pendencias,
    consultadoEm: new Date().toISOString(),
    raw
  };
}

// ── HANDLERS ──────────────────────────────────────────────────────────────────

async function handleCheck(db, body) {
  const { ownerId, tenantId, cpf } = body;
  if (!ownerId || !tenantId || !cpf) throw Object.assign(new Error('Dados inválidos'), { status: 400 });

  const cpfD = cpf.replace(/\D/g, '');
  if (cpfD.length !== 11) throw Object.assign(new Error('CPF inválido'), { status: 400 });

  // Busca credenciais da imobiliária
  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });
  const owner = ownerSnap.data();

  if (!owner.creditAnalysisEnabled) throw Object.assign(new Error('Módulo de análise não ativo'), { status: 403 });

  const clientId     = owner.serasaClientId     || '';
  const clientSecret = owner.serasaClientSecret || '';
  const isSandbox    = !clientId || !clientSecret || clientId.startsWith('sandbox');

  let report;
  if (isSandbox) {
    report = sandboxReport(cpfD);
  } else {
    const token = await getSerasaToken(clientId, clientSecret);
    const raw   = await querySerasa(cpfD, token);
    report = parseSerasaResponse(raw, cpfD);
  }

  // Salva resultado no perfil do inquilino
  await db.collection('users').doc(tenantId).update({
    'creditAnalysis.serasaReport':   report,
    'creditAnalysis.serasaCheckedAt': FieldValue.serverTimestamp(),
    'creditAnalysis.status': report.status === 'REGULAR' ? 'approved' : 'analyzing',
    'creditAnalysis.score':  report.score,
    updatedAt: FieldValue.serverTimestamp()
  });

  return report;
}

async function handleSaveCredentials(db, body, callerEmail) {
  const { ownerId, clientId, clientSecret } = body;
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  // Apenas o próprio owner ou o master pode salvar
  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });
  const owner = ownerSnap.data();

  const MASTER = process.env.MASTER_EMAIL || 'contatotransgu@gmail.com';
  if (callerEmail !== MASTER && owner.email !== callerEmail) {
    throw Object.assign(new Error('Sem permissão'), { status: 403 });
  }

  await db.collection('owners').doc(ownerId).update({
    serasaClientId:     clientId     || '',
    serasaClientSecret: clientSecret || '',
    updatedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db   = getFirestore();
    const { step, callerEmail } = req.body || {};

    let result;
    if      (step === 'check')            result = await handleCheck(db, req.body);
    else if (step === 'save-credentials') result = await handleSaveCredentials(db, req.body, callerEmail);
    else throw Object.assign(new Error('step inválido'), { status: 400 });

    res.status(200).json(result);
  } catch (e) {
    console.error('[locarpay-credit]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
}
