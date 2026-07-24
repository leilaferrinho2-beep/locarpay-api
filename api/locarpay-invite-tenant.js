// POST /api/locarpay-invite-tenant  { email, tenantName, ownerName, propertyDescription }
// Envia e-mail de boas-vindas para o inquilino recém-cadastrado

import nodemailer from 'nodemailer';

async function enviarConvite({ email, tenantName, ownerName, propertyDescription }) {
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
    subject: 'Você foi cadastrado no LocarPay',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#1565C0">LocarPay</h2>
        <p>Olá, <strong>${tenantName || 'inquilino'}</strong>!</p>
        <p>${ownerName ? `<strong>${ownerName}</strong> cadastrou você` : 'Você foi cadastrado'} como inquilino no aplicativo LocarPay.</p>
        ${propertyDescription ? `<p><strong>Imóvel:</strong> ${propertyDescription}</p>` : ''}
        <p>Agora você pode acessar o app LocarPay para acompanhar cobranças, contratos e muito mais.</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:24px 0">
          <p style="margin:0;font-size:14px;color:#555">
            <strong>Como acessar:</strong><br>
            Baixe o app LocarPay, informe este e-mail (<strong>${email}</strong>) e você receberá um código de acesso.
          </p>
        </div>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px;text-align:center">Equipe LocarPay</p>
      </div>
    `
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, tenantName, ownerName, propertyDescription } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email obrigatório' });

  try {
    await enviarConvite({ email: email.trim(), tenantName, ownerName, propertyDescription });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao enviar convite' });
  }
}
