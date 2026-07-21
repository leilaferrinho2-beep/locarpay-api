// POST /api/locarpay-send-otp  { email }
// Gera OTP de 6 dígitos, salva no Firestore do LocarPay, envia por email via Titan SMTP

import nodemailer from 'nodemailer';
import crypto from 'crypto';

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

async function salvarOtp(email, otp) {
  const id = Buffer.from(email).toString('base64').replace(/[^a-zA-Z0-9]/g, '_');
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hora
  const url = `${FS_BASE}/loginOtps/${id}?key=${FB_API_KEY}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        email: { stringValue: email },
        otp: { stringValue: otp },
        expiresAt: { integerValue: String(expiresAt) },
        used: { booleanValue: false }
      }
    })
  });
  if (!resp.ok) throw new Error('Erro ao salvar OTP no Firestore');
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
    from: 'LocarPay <denis@dlftech.com.br>',
    to: email,
    subject: 'Seu código de acesso ao LocarPay',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <h2 style="color:#1565C0">LocarPay</h2>
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
        <p style="color:#aaa;font-size:12px;text-align:center">Equipe LocarPay</p>
      </div>
    `
  });
}

async function verificarEmailCadastrado(email) {
  // Endpoint correto para structured query no Firestore REST API
  const url = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents:runQuery?key=${FB_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
              { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'tenant' } } }
            ]
          }
        },
        limit: 1
      }
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Firestore query falhou: ${err}`);
  }
  const data = await resp.json();
  // runQuery retorna array; cada item tem 'document' se encontrou resultado
  return Array.isArray(data) && data.some(item => item.document != null);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email obrigatório' });

  try {
    const cadastrado = await verificarEmailCadastrado(email.trim().toLowerCase());
    if (!cadastrado) {
      return res.status(403).json({ error: 'E-mail não cadastrado. Entre em contato com o proprietário.' });
    }

    const otp = String(Math.floor(100000 + crypto.randomInt(900000)));
    await salvarOtp(email.trim().toLowerCase(), otp);
    await enviarEmail(email.trim(), otp);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao enviar código' });
  }
}
