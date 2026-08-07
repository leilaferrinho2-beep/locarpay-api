// POST /api/locarpay-google-login
// Recebe Firebase ID token (Google Sign-In), verifica papel do usuário server-side.
// Usa Admin SDK — bypassa regras do Firestore.

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const idToken = req.headers['authorization']?.replace('Bearer ', '');
  if (!idToken) return res.status(400).json({ error: 'Token obrigatório' });

  try {
    initAdmin();
    const auth = getAuth();
    const db = getFirestore();

    // Verifica token — lança exceção se inválido/expirado
    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = (decoded.email || '').toLowerCase();

    if (!email) return res.status(400).json({ error: 'Email não disponível no token' });

    // Verifica papel: licença legada, owner, ou inquilino
    const [licenseDoc, ownerSnap, tenantSnap] = await Promise.all([
      db.collection('licenses').doc(email).get(),
      db.collection('owners').where('email', '==', email).limit(1).get(),
      db.collection('users').where('email', '==', email).limit(1).get()
    ]);

    const hasLicense = licenseDoc.exists && licenseDoc.data().active === true;
    const ownerDoc   = ownerSnap.empty ? null : ownerSnap.docs[0];

    const isAdmin = hasLicense || !!ownerDoc;

    if (!isAdmin) {
      // Verifica cadastro como inquilino ativo
      const tenantData = tenantSnap.empty ? null : tenantSnap.docs[0].data();
      if (!tenantData || tenantData.suspended === true) {
        // Cancela sessão no servidor
        await auth.revokeRefreshTokens(uid);
        return res.status(403).json({ error: 'E-mail não cadastrado. Entre em contato com a imobiliária.' });
      }
    }

    const role    = isAdmin ? 'admin' : 'tenant';
    const ownerId = ownerDoc
      ? ownerDoc.id
      : (tenantSnap.empty ? null : (tenantSnap.docs[0].data().ownerId || null));

    // Atualiza custom claims para que o app use role diretamente
    await auth.setCustomUserClaims(uid, { role, ownerId: ownerId || '' });

    return res.status(200).json({ ok: true, role, ownerId });
  } catch (e) {
    if (e.code === 'auth/id-token-expired' || e.code === 'auth/argument-error') {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Erro ao verificar login' });
  }
}
