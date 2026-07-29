// POST /api/locarpay-migrate
// Endpoint interno (protegido por secret) para migrar dados legados ao modelo SaaS
// Adiciona ownerId em users, contracts, charges que ainda não têm
// Body: { secret, ownerId }

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

async function migrateCollection(db, collectionName, ownerId) {
  const snap = await db.collection(collectionName).where('ownerId', '==', null).limit(500).get();
  // Firestore não suporta where field == null diretamente — busca todos e filtra
  const allSnap = await db.collection(collectionName).limit(500).get();
  const docs = allSnap.docs.filter(d => !d.data().ownerId);

  if (docs.length === 0) return 0;

  const batch = db.batch();
  docs.forEach(doc => batch.update(doc.ref, { ownerId }));
  await batch.commit();
  return docs.length;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { secret, ownerId } = req.body || {};

  if (secret !== process.env.MIGRATE_SECRET) {
    return res.status(403).json({ error: 'Não autorizado' });
  }
  if (!ownerId) {
    return res.status(400).json({ error: 'ownerId obrigatório' });
  }

  try {
    initFirebase();
    const db = getFirestore();

    // Verifica que o owner existe
    const ownerSnap = await db.collection('owners').doc(ownerId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'Owner não encontrado' });

    const [users, contracts, charges] = await Promise.all([
      migrateCollection(db, 'users',     ownerId),
      migrateCollection(db, 'contracts', ownerId),
      migrateCollection(db, 'charges',   ownerId),
    ]);

    return res.status(200).json({
      ok: true,
      migrated: { users, contracts, charges },
      ownerId,
    });

  } catch (e) {
    console.error('migrate error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
