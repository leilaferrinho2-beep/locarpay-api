// POST /api/locarpay-verify-otp  { email, otp }
// Valida OTP no Firestore do LocarPay, retorna Firebase custom token

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function initAdmin() {
  if (getApps().length > 0) return;
  const serviceAccount = JSON.parse(process.env.LOCARPAY_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: 'Email e código obrigatórios' });

  try {
    initAdmin();
    const db = getFirestore();
    const auth = getAuth();

    const id = Buffer.from(email).toString('base64').replace(/[^a-zA-Z0-9]/g, '_');
    const doc = await db.collection('loginOtps').doc(id).get();

    if (!doc.exists) return res.status(401).json({ error: 'Código inválido' });

    const data = doc.data();
    if (data.used) return res.status(401).json({ error: 'Código já utilizado' });
    if (data.otp !== otp) return res.status(401).json({ error: 'Código incorreto' });
    if (Date.now() > Number(data.expiresAt)) return res.status(401).json({ error: 'Código expirado' });

    // Marca como usado
    await doc.ref.update({ used: true });

    // Busca ou cria usuário no Firebase Auth
    let uid;
    try {
      const user = await auth.getUserByEmail(email);
      uid = user.uid;
    } catch {
      const newUser = await auth.createUser({ email });
      uid = newUser.uid;
    }

    // Busca role do usuário no Firestore
    const userDoc = await db.collection('users').doc(uid).get();
    const role = userDoc.exists ? (userDoc.data().role || 'tenant') : 'tenant';

    const customToken = await auth.createCustomToken(uid, { role });
    return res.status(200).json({ ok: true, customToken, role });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao verificar código' });
  }
}
