// GET  → serve admin HTML
// POST → superadmin API (requer x-admin-token do super admin)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth }                        from 'firebase-admin/auth';
import { getFirestore, Timestamp }        from 'firebase-admin/firestore';

const SUPER_ADMIN_EMAIL = 'denisfelicio20@gmail.com';

function initFirebase() {
  if (getApps().length) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT;
  if (!sa) throw new Error('ENV: service account não configurada (LOCARPAY_SERVICE_ACCOUNT / FIREBASE_SERVICE_ACCOUNT)');
  initializeApp({ credential: cert(JSON.parse(sa)) });
}

async function verifyAdmin(req) {
  const token = req.headers['x-admin-token'];
  if (!token) throw Object.assign(new Error('Token ausente'), { status: 401 });
  const decoded = await getAuth().verifyIdToken(token);
  if (decoded.email !== SUPER_ADMIN_EMAIL)
    throw Object.assign(new Error('Acesso negado'), { status: 403 });
  return decoded;
}

async function listOwners(db) {
  const snap = await db.collection('owners').orderBy('createdAt', 'desc').get();
  const owners = snap.docs.map(d => {
    const data = d.data();
    return {
      ownerId:            d.id,
      name:               data.name            || '',
      email:              data.email           || '',
      phone:              data.phone           || '',
      cpfCnpj:            data.cpfCnpj         || '',
      plan:               data.plan            || 'trial',
      status:             data.status          || 'trial',
      monthlyPrice:       data.monthlyPrice    || 0,
      maxTenants:         data.maxTenants      || 3,
      asaasConfigured:    !!data.asaasApiKey,
      asaasWarning:       data.asaasWarning       || null,
      asaasSubaccountId:  data.asaasSubaccountId  || null,
      assinafyConfigured: !!data.assinafyApiKey,
      trialEndsAt:        data.trialEndsAt?.toDate?.()?.toISOString()     || null,
      planActiveUntil:    data.planActiveUntil?.toDate?.()?.toISOString() || null,
      createdAt:          data.createdAt?.toDate?.()?.toISOString()       || null,
      subscriptionId:     data.subscriptionId  || null,
      billingStatus:      data.billingStatus   || null,
    };
  });
  return { owners, total: owners.length };
}

async function activateOwner(db, ownerId) {
  const ref = db.collection('owners').doc(ownerId);
  if (!(await ref.get()).exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  const planActiveUntil = Timestamp.fromMillis(Date.now() + 32 * 24 * 60 * 60 * 1000);
  await ref.update({ status: 'active', planActiveUntil });
  return { message: 'Imobiliária ativada com sucesso.' };
}

async function suspendOwner(db, ownerId) {
  const ref = db.collection('owners').doc(ownerId);
  if (!(await ref.get()).exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  await ref.update({ status: 'suspended' });
  return { message: 'Imobiliária suspensa.' };
}

async function deleteOwner(db, ownerId) {
  const ref = db.collection('owners').doc(ownerId);
  if (!(await ref.get()).exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });
  await ref.delete();
  return { message: 'Imobiliária excluída permanentemente.' };
}

async function setupAsaas(db, ownerId) {
  const r = await fetch('https://ilocarpay.com.br/api/locarpay-owner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: 'setup-asaas', ownerId })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Erro ao criar subconta Asaas');
  return { message: 'Subconta Asaas criada com sucesso.' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return res.status(302).setHeader('Location', '/admin').end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // POST → superadmin API
  try {
    initFirebase();
    await verifyAdmin(req);
    const db = getFirestore();
    const { step, ownerId } = req.body || {};

    if (step === 'list-owners')    return res.status(200).json(await listOwners(db));
    if (step === 'activate-owner') return res.status(200).json(await activateOwner(db, ownerId));
    if (step === 'suspend-owner')  return res.status(200).json(await suspendOwner(db, ownerId));
    if (step === 'delete-owner')   return res.status(200).json(await deleteOwner(db, ownerId));
    if (step === 'setup-asaas')    return res.status(200).json(await setupAsaas(db, ownerId));

    return res.status(400).json({ error: 'step inválido' });
  } catch(e) {
    console.error('admin/superadmin error:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
