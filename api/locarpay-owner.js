// POST /api/locarpay-owner
// step:"register" → { name, email, phone?, cnpj?, plan?, firebaseUid? } → cadastra nova imobiliária
// step:"migrate"  → { secret, ownerId } → adiciona ownerId em docs legados (requer MIGRATE_SECRET)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp }       from 'firebase-admin/firestore';

const PLANS = {
  trial: { maxTenants: 3,  maxProperties: 2,  monthlyPrice: 0   },
  basic: { maxTenants: 10, maxProperties: 5,  monthlyPrice: 49  },
  pro:   { maxTenants: 30, maxProperties: 20, monthlyPrice: 99  },
};

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

async function handleRegister(db, body) {
  const { name, email, phone, cnpj, plan = 'trial', firebaseUid } = body;
  if (!name || !email) throw Object.assign(new Error('name e email são obrigatórios'), { status: 400 });

  const existing = await db.collection('owners').where('email', '==', email).limit(1).get();
  if (!existing.empty) {
    throw Object.assign(new Error('Email já cadastrado'), { status: 409, ownerId: existing.docs[0].id });
  }

  const now = Timestamp.now();
  const trialEndsAt = Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const planConfig = PLANS[plan] || PLANS.trial;

  const docRef = firebaseUid
    ? db.collection('owners').doc(firebaseUid)
    : db.collection('owners').doc();

  await docRef.set({
    name,
    email,
    phone:  phone  || '',
    cnpj:   cnpj   || '',
    plan,
    status: 'trial',
    maxTenants:    planConfig.maxTenants,
    maxProperties: planConfig.maxProperties,
    monthlyPrice:  planConfig.monthlyPrice,
    asaasApiKey:       '',
    asaasSubaccountId: '',
    assinafyApiKey:    '',
    createdAt:     now,
    trialEndsAt,
    planActiveUntil: trialEndsAt,
  });

  return {
    ownerId: docRef.id,
    trialEndsAt: trialEndsAt.toDate().toISOString(),
    plan,
    message: 'Owner cadastrado com sucesso. Trial de 14 dias ativo.',
  };
}

async function migrateCollection(db, collectionName, ownerId) {
  const allSnap = await db.collection(collectionName).limit(500).get();
  const docs = allSnap.docs.filter(d => !d.data().ownerId);
  if (docs.length === 0) return 0;
  const batch = db.batch();
  docs.forEach(doc => batch.update(doc.ref, { ownerId }));
  await batch.commit();
  return docs.length;
}

async function handleMigrate(db, body) {
  const { secret, ownerId } = body;
  if (secret !== process.env.MIGRATE_SECRET) throw Object.assign(new Error('Não autorizado'), { status: 403 });
  if (!ownerId) throw Object.assign(new Error('ownerId obrigatório'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Owner não encontrado'), { status: 404 });

  const [users, contracts, charges] = await Promise.all([
    migrateCollection(db, 'users',     ownerId),
    migrateCollection(db, 'contracts', ownerId),
    migrateCollection(db, 'charges',   ownerId),
  ]);

  return { ok: true, migrated: { users, contracts, charges }, ownerId };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();
    const { step } = req.body || {};

    if (step === 'register') return res.status(201).json(await handleRegister(db, req.body));
    if (step === 'migrate')  return res.status(200).json(await handleMigrate(db, req.body));
    return res.status(400).json({ error: 'step inválido (register|migrate)' });

  } catch (e) {
    console.error('locarpay-owner error:', e.message);
    return res.status(e.status || 500).json({ error: e.message, ...(e.ownerId ? { ownerId: e.ownerId } : {}) });
  }
}
