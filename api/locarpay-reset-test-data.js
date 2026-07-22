// Endpoint temporário — apagar após uso
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initAdmin() {
  if (getApps().length > 0) return;
  initializeApp({ credential: cert(JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

async function deleteCollection(db, name) {
  const snap = await db.collection(name).limit(500).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  // recursivo para mais de 500 docs
  return snap.size + await deleteCollection(db, name);
}

export default async function handler(req, res) {
  const { secret } = req.body || {};
  if (secret !== 'lp-reset-locarpay-2024') return res.status(403).json({ error: 'Forbidden' });

  initAdmin();
  const db = getFirestore();

  const results = {};
  for (const col of ['contracts', 'users', 'charges', 'loginOtps', 'adjustments', 'messages']) {
    results[col] = await deleteCollection(db, col);
  }

  return res.status(200).json({ ok: true, deleted: results });
}
