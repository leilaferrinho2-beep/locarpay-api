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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Fluxo Google Sign-In: Authorization header presente
  const bearerToken = req.headers['authorization']?.replace('Bearer ', '');
  if (bearerToken) {
    return handleGoogleLogin(req, res, bearerToken);
  }

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

    // Role: admin se tiver licença ativa OU estiver em owners, senão tenant
    const [licenseDoc, ownerSnap] = await Promise.all([
      db.collection('licenses').doc(email.toLowerCase()).get(),
      db.collection('owners').where('email', '==', email.toLowerCase()).limit(1).get()
    ]);
    const hasLicense  = licenseDoc.exists && licenseDoc.data().active === true;
    const ownerDoc    = ownerSnap.empty ? null : ownerSnap.docs[0];
    const ownerFromDb = ownerDoc?.data() || null;

    // Busca documento do usuário — pode ter sido criado com ID diferente do UID (pelo admin)
    let userRole = 'tenant';
    let userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      // Documento ainda não está no caminho users/{uid} — busca pelo email
      const emailQuery = await db.collection('users')
        .where('email', '==', email.toLowerCase())
        .limit(1).get();

      if (!emailQuery.empty) {
        const existing = emailQuery.docs[0];
        userRole = existing.data().role || 'tenant';

        // Cria/atualiza users/{uid} com os dados do usuário para que futuras
        // buscas por UID funcionem (ex: aceite de termos, perfil)
        await db.collection('users').doc(uid).set({
          ...existing.data(),
          id: uid,
          authUid: uid
        }, { merge: true });
      } else {
        // Usuário não cadastrado pelo admin
        userRole = 'tenant';
      }
    } else {
      userRole = userDoc.data().role || 'tenant';
    }

    const isAdmin = hasLicense || !!ownerDoc;
    const role = isAdmin ? 'admin' : userRole;

    // ownerId: para owners é o próprio doc ID; para tenants busca no users
    let ownerId = null;
    if (ownerDoc) {
      ownerId = ownerDoc.id;
    } else {
      try {
        const userSnap = await db.collection('users').doc(uid).get();
        ownerId = userSnap.data()?.ownerId || null;
        if (!ownerId) {
          const q = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
          if (!q.empty) ownerId = q.docs[0].data().ownerId || null;
        }
      } catch (_) {}
    }

    await auth.setCustomUserClaims(uid, { role, ownerId });
    const customToken = await auth.createCustomToken(uid, { role, ownerId });
    return res.status(200).json({ ok: true, customToken, role, ownerId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao verificar código' });
  }
}

async function handleGoogleLogin(req, res, idToken) {
  try {
    initAdmin();
    const auth = getAuth();
    const db = getFirestore();

    const decoded = await auth.verifyIdToken(idToken);
    const uid   = decoded.uid;
    const email = (decoded.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email não disponível no token' });

    const [licenseDoc, ownerSnap, tenantSnap] = await Promise.all([
      db.collection('licenses').doc(email).get(),
      db.collection('owners').where('email', '==', email).limit(1).get(),
      db.collection('users').where('email', '==', email).limit(1).get()
    ]);

    const hasLicense = licenseDoc.exists && licenseDoc.data().active === true;
    const ownerDoc   = ownerSnap.empty ? null : ownerSnap.docs[0];
    const isAdmin    = hasLicense || !!ownerDoc;

    const tenantData = tenantSnap.empty ? null : tenantSnap.docs[0].data();

    if (!isAdmin) {
      if (!tenantData || tenantData.suspended === true) {
        await auth.revokeRefreshTokens(uid);
        return res.status(403).json({ error: 'E-mail não cadastrado. Entre em contato com a imobiliária.' });
      }
    }

    let role = 'tenant';
    if (isAdmin) {
      role = 'admin';
    } else if (tenantData?.role === 'broker' || tenantData?.role === 'corretor') {
      role = 'corretor';
    }

    const ownerId = ownerDoc
      ? ownerDoc.id
      : (tenantData?.ownerId || null);

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
