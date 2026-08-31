// POST /api/ilocarpay-send-otp  { email }          → ?action=send  (via rewrite)
// POST /api/ilocarpay-verify-otp { email, otp }    → ?action=verify (via rewrite)

import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { rateLimit, rateLimitReset, sanitizeString, isValidEmail, getClientIp } from './_security.js';

function initAdmin() {
  if (getApps().length > 0) return;
  const serviceAccount = JSON.parse(process.env.IILOCARPAY_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

async function enviarEmail(email, otp) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email',
    port: 587,
    secure: false,
    auth: {
      user: 'denis@dlftech.com.br',
      pass: process.env.TITAN_SMTP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: 'iiLocarPay <denis@dlftech.com.br>',
    to: email,
    subject: 'Seu código de acesso ao iLocarPay',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <h2 style="color:#1565C0">iLocarPay</h2>
        <p>Olá,</p>
        <p>Seu código de acesso é:</p>
        <div style="text-align:center;margin:32px 0">
          <span style="background:#1565C0;color:white;padding:16px 32px;border-radius:8px;font-size:32px;font-weight:bold;letter-spacing:8px">
            ${otp}
          </span>
        </div>
        <p style="color:#888;font-size:13px">Este código expira em 1 hora e só pode ser usado uma vez.</p>
        <p style="color:#888;font-size:13px">Se você não solicitou este acesso, ignore este e-mail.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px;text-align:center">Equipe iLocarPay</p>
      </div>
    `
  });
}

async function handleSend(req, res) {
  const email = sanitizeString(req.body?.email || '', 254);
  if (!email) return res.status(400).json({ error: 'Email obrigatório' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email inválido' });

  const ip = getClientIp(req);
  initAdmin();
  try {
    await rateLimit(`send-otp:ip:${ip}`,       { maxRequests: 3, windowSeconds: 60  });
    await rateLimit(`send-otp:email:${email}`,  { maxRequests: 5, windowSeconds: 600 });

    const db = getFirestore();
    const emailNorm = email.trim().toLowerCase();

    const [licenseDoc, ownerSnap, tenantSnap, brokerSnap] = await Promise.all([
      db.collection('licenses').doc(emailNorm).get(),
      db.collection('owners').where('email', '==', emailNorm).limit(1).get(),
      db.collection('users').where('email', '==', emailNorm).limit(1).get(),
      db.collection('brokers').where('email', '==', emailNorm).limit(1).get()
    ]);

    const temLicenca = licenseDoc.exists && licenseDoc.data().active === true;
    const temOwner   = !ownerSnap.empty;
    const brokerData = brokerSnap.empty ? null : brokerSnap.docs[0].data();
    const temBroker  = brokerData !== null && brokerData.active !== false;
    const tenantDoc  = tenantSnap.empty ? null : tenantSnap.docs[0].data();
    const temCadastro = tenantDoc !== null && tenantDoc.suspended !== true;

    console.log('[send-otp] email:', emailNorm,
      '| licenca:', temLicenca, '| owner:', temOwner,
      '| broker:', temBroker, '| cadastro:', temCadastro);

    if (!temLicenca && !temOwner && !temBroker && !temCadastro) {
      return res.status(403).json({ error: 'E-mail não cadastrado. Entre em contato com a imobiliária.' });
    }

    const otp = String(Math.floor(100000 + crypto.randomInt(900000)));
    const id  = Buffer.from(emailNorm).toString('base64').replace(/[^a-zA-Z0-9]/g, '_');
    await db.collection('loginOtps').doc(id).set({
      email: emailNorm,
      otp,
      expiresAt: Date.now() + 60 * 60 * 1000,
      used: false
    });
    await enviarEmail(email.trim(), otp);
    return res.status(200).json({ ok: true });
  } catch (e) {
    if (e.status === 429) {
      res.setHeader('Retry-After', String(e.retryAfter || 60));
      return res.status(429).json({ error: e.message });
    }
    console.error('[send-otp error]', e?.message, e?.code);
    return res.status(500).json({ error: 'Erro ao enviar código' });
  }
}

async function handleVerify(req, res) {
  const bearerToken = req.headers['authorization']?.replace('Bearer ', '');
  if (bearerToken) return handleGoogleLogin(req, res, bearerToken);

  const email = sanitizeString(req.body?.email || '', 254).toLowerCase();
  const otp   = sanitizeString(req.body?.otp   || '', 10);
  if (!email || !otp) return res.status(400).json({ error: 'Email e código obrigatórios' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email inválido' });

  const ip = getClientIp(req);
  console.log('[verify-otp] start email:', email, 'ip:', ip);
  initAdmin();
  try {
    await rateLimit(`otp:ip:${ip}`,       { maxRequests: 5,  windowSeconds: 60  });
    await rateLimit(`otp:email:${email}`, { maxRequests: 10, windowSeconds: 300 });

    const db   = getFirestore();
    const auth = getAuth();

    const id  = Buffer.from(email).toString('base64').replace(/[^a-zA-Z0-9]/g, '_');
    const doc = await db.collection('loginOtps').doc(id).get();
    if (!doc.exists) return res.status(401).json({ error: 'Código inválido' });

    const data = doc.data();
    if (data.used)            return res.status(401).json({ error: 'Código já utilizado' });
    if (data.otp !== otp)     return res.status(401).json({ error: 'Código incorreto' });
    if (Date.now() > Number(data.expiresAt)) return res.status(401).json({ error: 'Código expirado' });

    await doc.ref.update({ used: true });

    let uid;
    try {
      const user = await auth.getUserByEmail(email);
      uid = user.uid;
    } catch {
      const newUser = await auth.createUser({ email });
      uid = newUser.uid;
    }

    const [licenseDoc, ownerSnap] = await Promise.all([
      db.collection('licenses').doc(email.toLowerCase()).get(),
      db.collection('owners').where('email', '==', email.toLowerCase()).limit(1).get()
    ]);
    const hasLicense = licenseDoc.exists && licenseDoc.data().active === true;
    const ownerDoc   = ownerSnap.empty ? null : ownerSnap.docs[0];

    let userRole = 'tenant';
    let userDoc  = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      const emailQuery = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
      if (!emailQuery.empty) {
        const existing = emailQuery.docs[0];
        userRole = existing.data().role || 'tenant';
        await db.collection('users').doc(uid).set({ ...existing.data(), id: uid, authUid: uid }, { merge: true });
      }
    } else {
      userRole = userDoc.data().role || 'tenant';
    }

    const isAdmin    = hasLicense || !!ownerDoc;
    const mappedRole = (userRole === 'broker' || userRole === 'corretor') ? 'corretor' : userRole;
    const role       = isAdmin ? 'admin' : mappedRole;

    let ownerId = null, ownerIds = [];
    if (ownerDoc) {
      ownerId = ownerDoc.id;
      ownerIds = [ownerId];
    } else {
      try {
        const userSnap = await db.collection('users').doc(uid).get();
        ownerId = userSnap.data()?.ownerId || null;
        if (!ownerId) {
          const q = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
          if (!q.empty) ownerId = q.docs[0].data().ownerId || null;
        }
        const bq = await db.collection('brokers').where('email', '==', email.toLowerCase()).get();
        if (!bq.empty) {
          ownerIds = bq.docs.map(d => d.data().ownerId).filter(Boolean);
          const activeDoc = bq.docs.find(d => d.data().active !== false);
          if (!ownerId) ownerId = (activeDoc || bq.docs[0]).data().ownerId || null;
        }
        if (ownerIds.length === 0 && ownerId) ownerIds = [ownerId];
      } catch (_) {}
    }

    await auth.setCustomUserClaims(uid, { role, ownerId, ownerIds });
    const customToken = await auth.createCustomToken(uid, { role, ownerId, ownerIds });
    await rateLimitReset(`otp:ip:${ip}`);
    await rateLimitReset(`otp:email:${email}`);
    return res.status(200).json({ ok: true, customToken, role, ownerId, ownerIds });
  } catch (e) {
    if (e.status === 429) {
      res.setHeader('Retry-After', String(e.retryAfter || 60));
      return res.status(429).json({ error: e.message });
    }
    console.error(e);
    return res.status(500).json({ error: 'Erro ao verificar código' });
  }
}

async function handleGoogleLogin(req, res, idToken) {
  try {
    initAdmin();
    const auth = getAuth();
    const db   = getFirestore();

    const decoded = await auth.verifyIdToken(idToken);
    const uid   = decoded.uid;
    const email = (decoded.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email não disponível no token' });

    const [licenseDoc, ownerSnap, tenantSnap, brokerSnap] = await Promise.all([
      db.collection('licenses').doc(email).get(),
      db.collection('owners').where('email', '==', email).limit(1).get(),
      db.collection('users').where('email', '==', email).limit(1).get(),
      db.collection('brokers').where('email', '==', email).limit(1).get()
    ]);

    const hasLicense = licenseDoc.exists && licenseDoc.data().active === true;
    const ownerDoc   = ownerSnap.empty ? null : ownerSnap.docs[0];
    const isAdmin    = hasLicense || !!ownerDoc;
    const brokerData = brokerSnap.empty ? null : brokerSnap.docs[0].data();
    const isBroker   = brokerData !== null && brokerData.active !== false;
    const tenantData = tenantSnap.empty ? null : tenantSnap.docs[0].data();

    if (!isAdmin && !isBroker) {
      if (!tenantData || tenantData.suspended === true) {
        await auth.revokeRefreshTokens(uid);
        return res.status(403).json({ error: 'E-mail não cadastrado. Entre em contato com a imobiliária.' });
      }
    }

    let role = 'tenant';
    if (isAdmin) role = 'admin';
    else if (isBroker || tenantData?.role === 'broker' || tenantData?.role === 'corretor') role = 'corretor';

    const ownerId = ownerDoc
      ? ownerDoc.id
      : (brokerData?.ownerId || tenantData?.ownerId || null);

    await auth.setCustomUserClaims(uid, { role, ownerId: ownerId || '' });

    if (tenantData) {
      const uidRef  = db.collection('users').doc(uid);
      const uidSnap = await uidRef.get();
      const savedName = tenantData.name || '';
      if (!uidSnap.exists) {
        await uidRef.set({ ...tenantData, id: uid, authUid: uid }, { merge: true });
      } else if (savedName && (!uidSnap.data().name || uidSnap.data().name === email.split('@')[0])) {
        await uidRef.update({ name: savedName });
      }
    }

    return res.status(200).json({ ok: true, role, ownerId });
  } catch (e) {
    if (e.code === 'auth/id-token-expired' || e.code === 'auth/argument-error') {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Erro ao verificar login' });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query?.action;
  if (action === 'send')   return handleSend(req, res);
  if (action === 'verify') return handleVerify(req, res);
  return res.status(400).json({ error: 'action obrigatório: send ou verify' });
}
