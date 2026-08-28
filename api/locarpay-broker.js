// POST /api/locarpay-broker — Fluxo completo do corretor
// GET  /api/locarpay-broker?view=contract&contractId=xxx — HTML do contrato (para Assinafy)
//
// Steps POST:
//   register-broker   → { ownerId, name, email, phone }         → cadastra corretor
//   submit-lead       → { ownerId, brokerEmail, tenant, docs, propertyCode, propertyDescription }
//   approve-lead      → { leadId, contractData }                → ativa inquilino + gera contrato Assinafy
//   reject-lead       → { leadId, reason }
//   generate-contract → { contractId }                         → (re)cria documento Assinafy
//   deliver-keys      → { contractId, tenantId }               → ativa contrato + push notification

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';
import { getMessaging }                  from 'firebase-admin/messaging';
import { getStorage }                    from 'firebase-admin/storage';
import nodemailer                         from 'nodemailer';
import { PDFDocument as PdfLib, rgb, StandardFonts } from 'pdf-lib';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

const ASSINAFY_BASE = 'https://api.assinafy.com.br/v1';
const APP_BASE_URL  = process.env.APP_BASE_URL || 'https://ilocarpay.com.br';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Monta endereço completo na ordem correta: Logradouro, Nº, Complemento, Bairro, Cidade/UF
function buildAddr(p = {}) {
  const parts = [
    p.street || p.logradouro,
    p.number  || p.numero,
    p.complement || p.complemento,
    p.neighborhood || p.bairro,
  ].filter(Boolean);
  const cityUf = [p.city || p.cidade, p.state || p.estado].filter(Boolean).join('/');
  if (cityUf) parts.push(cityUf);
  return parts.join(', ');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assinafyReq(method, path, body, apiKey) {
  const isFormData = body instanceof FormData;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let r;
  try {
    r = await fetch(`${ASSINAFY_BASE}/${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json',
        ...(!isFormData ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: isFormData ? body : JSON.stringify(body) } : {})
    });
  } finally { clearTimeout(timer); }
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Assinafy ${method} ${path} ${r.status}: ${text}`);
  return data;
}

async function generateContractPdf(data) {
  const fmt = v => 'R$ ' + (parseFloat(v) || 0).toFixed(2).replace('.', ',').replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1.');
  const fmtDate = d => d ? String(d) : '—';

  const pdfDoc = await PdfLib.create();
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const addPage = () => {
    const page = pdfDoc.addPage([595, 842]); // A4
    return { page, y: 800 };
  };

  let { page, y } = addPage();
  const margin = 50;
  const width  = 595 - margin * 2;
  const lineH  = 14;

  const write = (text, opts = {}) => {
    const f    = opts.bold ? boldFont : font;
    const size = opts.size || 10;
    const x    = opts.x ?? margin;
    if (y - size < 50) { ({ page, y } = addPage()); }
    page.drawText(String(text || ''), { x, y: y - size, font: f, size, color: rgb(0, 0, 0), maxWidth: opts.width ?? width });
    y -= (size + (opts.gap ?? 2));
  };

  const section = (title) => {
    y -= 6;
    write(title, { bold: true, size: 11 });
    page.drawLine({ start: { x: margin, y }, end: { x: 595 - margin, y }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) });
    y -= 4;
  };

  const field = (label, value) => write(`${label}: ${value || '—'}`);

  // Cabeçalho
  write('CONTRATO DE LOCAÇÃO RESIDENCIAL', { bold: true, size: 16, gap: 4 });
  write(`Emitido por iLocarPay — ${new Date().toLocaleDateString('pt-BR')}`, { size: 9, gap: 14 });

  section('1. DAS PARTES');
  field('Locador / Proprietário', data.ownerName);
  field('CPF/CNPJ do Locador', data.ownerCpf);
  field('E-mail do Locador', data.ownerEmail);
  y -= 4;
  field('Locatário (Inquilino)', data.tenantName);
  field('CPF do Locatário', data.tenantCpf);
  field('E-mail do Locatário', data.tenantEmail);
  field('Telefone do Locatário', data.tenantPhone);

  section('2. DO IMÓVEL');
  field('Endereço', data.propertyAddress);
  field('Código do Imóvel', data.propertyCode);

  section('3. DO PRAZO E VALOR');
  field('Início da Locação', fmtDate(data.startDate));
  field('Término da Locação', fmtDate(data.endDate));
  field('Aluguel Mensal', fmt(data.baseRent));
  field('Vencimento', `Todo dia ${data.dueDay || 10} de cada mês`);
  if (data.deposit) field('Caução', fmt(data.deposit));

  const clauses = [
    ['4. DAS OBRIGAÇÕES DO LOCATÁRIO', 'O locatário se obriga a pagar pontualmente o aluguel na data convencionada, conservar o imóvel em bom estado, não efetuar obras ou modificações sem anuência prévia do locador, e restituir o imóvel no estado em que o recebeu ao término do contrato.'],
    ['5. DAS OBRIGAÇÕES DO LOCADOR', 'O locador se obriga a entregar o imóvel em condições de uso, manter a posse mansa e pacífica do imóvel durante a locação, e responder pelos vícios ou defeitos anteriores à locação.'],
    ['6. DA RESCISÃO', 'O contrato pode ser rescindido por qualquer das partes mediante notificação prévia de 30 dias. A rescisão sem justa causa pelo locatário antes do prazo implica multa proporcional ao período restante.'],
    ['7. DO FORO', 'As partes elegem o foro da comarca do imóvel locado para dirimir quaisquer controvérsias oriundas deste contrato.'],
  ];
  for (const [title, text] of clauses) {
    section(title);
    // Quebra manual do texto em linhas de ~90 chars
    const words = text.split(' ');
    let line = '';
    for (const w of words) {
      if ((line + w).length > 88) { write(line.trim()); line = ''; }
      line += w + ' ';
    }
    if (line.trim()) write(line.trim());
  }

  // Assinaturas
  y -= 20;
  write('_________________________________', { x: margin });
  write(data.ownerName || 'Locador / Proprietário', { x: margin });
  const sigY = y;
  write('_________________________________', { x: 315 });
  write(data.tenantName || 'Locatário (Inquilino)', { x: 315 });
  y = Math.min(y, sigY);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

async function getAssinafyAccount(apiKey) {
  const res = await assinafyReq('GET', 'accounts', null, apiKey);
  const accountId = res?.data?.[0]?.id;
  if (!accountId) throw new Error('Conta Assinafy não encontrada');
  return accountId;
}

async function getOrCreateSigner(apiKey, accountId, name, email) {
  // Tenta criar; se já existe (400/422) busca pelo email com filtro
  try {
    const res = await assinafyReq('POST', `accounts/${accountId}/signers`, { full_name: name, email }, apiKey);
    return res?.data?.id || res?.id;
  } catch (e) {
    const status = e.message.match(/\s(\d{3}):/)?.[1];
    if (status !== '400' && status !== '422') throw e;
  }
  // Busca por email com query param (mais rápido que listar todos)
  try {
    const res = await assinafyReq('GET', `accounts/${accountId}/signers?email=${encodeURIComponent(email)}`, null, apiKey);
    const found = (res?.data || []).find(s => s.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
  } catch (_) {}
  // Fallback: lista completa
  const list = await assinafyReq('GET', `accounts/${accountId}/signers`, null, apiKey);
  const existing = (list?.data || []).find(s => s.email?.toLowerCase() === email.toLowerCase());
  if (existing) return existing.id;
  throw new Error(`Signatário não encontrado para ${email}`);
}

async function sendEmail(to, subject, html, attachments) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 465, secure: true,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });
  await transporter.sendMail({ from: 'iLocarPay <denis@dlftech.com.br>', to, subject, html, attachments });
}

async function sendContractEmail({ landlordName, landlordEmail, tenantName, tenantEmail, propAddr, pdfData }) {
  const addrLine = propAddr ? `<div style="background:#f0f7f0;border-left:4px solid #4CAF50;padding:12px 16px;border-radius:4px;margin:16px 0"><strong>Imóvel:</strong> ${propAddr}</div>` : '';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
      <div style="background:#1a1a1a;padding:32px;text-align:center">
        <h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1>
        <p style="color:#ccc;margin:8px 0 0">Gestão inteligente de aluguéis</p>
      </div>
      <div style="padding:32px">
        <p style="font-size:18px;font-weight:bold;color:#1a1a1a">Contrato de Locação</p>
        <p style="color:#444">Olá, <strong>${landlordName || 'Proprietário'}</strong>!</p>
        <p style="color:#444">Segue em anexo o contrato de locação referente ao inquilino <strong>${tenantName || tenantEmail}</strong>.</p>
        ${addrLine}
        <p style="color:#444">Por favor, revise o contrato. Em breve você receberá o link para assinatura digital.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px;text-align:center">Equipe iLocarPay • <a href="https://www.ilocarpay.com.br" style="color:#4CAF50">ilocarpay.com.br</a></p>
      </div>
    </div>`;
  await sendEmail(landlordEmail, '📄 Contrato de Locação — iLocarPay', html, [
    { filename: `contrato_${(tenantName || tenantEmail).replace(/\s+/g, '_')}.pdf`, content: pdfData, contentType: 'application/pdf' }
  ]);
}

async function sendWhatsApp(phone, message, ownerData = null, ownerId = null) {
  const { baseUrl, apiKey, instance } = getEvoConfig(ownerData, ownerId);
  if (!baseUrl || !apiKey || !instance || !phone) return;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return;
  const number = digits.startsWith('55') ? digits : `55${digits}`;
  try {
    const r = await fetch(`${baseUrl}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number, text: message, options: { linkPreview: true } })
    });
    if (!r.ok) console.warn('[whatsapp] sendText falhou:', await r.text().catch(() => r.status));
  } catch (e) { console.warn('[whatsapp]', e.message); }
}

async function sendPush(db, tenantId, title, body) {
  try {
    const snap = await db.collection('users').doc(tenantId).get();
    const token = snap.data()?.fcmToken;
    if (!token) return;
    await getMessaging().send({ token, notification: { title, body } });
  } catch (e) { console.warn('[push]', e.message); }
}

// ── Contrato HTML (servido para a Assinafy fazer upload) ─────────────────────

function generateContractHtml(data) {
  const fmt = v => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtDate = d => d ? new Date(d).toLocaleDateString('pt-BR') : '—';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; max-width: 720px; margin: 40px auto; padding: 0 32px; line-height: 1.7; }
  h1 { font-size: 18px; text-align: center; margin-bottom: 4px; }
  h2 { font-size: 13px; margin-top: 24px; font-weight: bold; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  .parties { background: #f7f7f7; border: 1px solid #e0e0e0; border-radius: 6px; padding: 16px 20px; margin: 20px 0; }
  .row { display: flex; gap: 32px; margin-top: 8px; }
  .field { flex: 1; }
  .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .05em; }
  .value { font-weight: bold; font-size: 13px; }
  p { margin: 10px 0; }
  .sign-area { margin-top: 60px; display: flex; gap: 60px; }
  .sign-box { flex: 1; border-top: 1px solid #333; padding-top: 8px; text-align: center; font-size: 12px; color: #555; }
  .highlight { background: #fffde7; padding: 2px 6px; border-radius: 3px; font-weight: bold; }
</style>
</head>
<body>
<h1>CONTRATO DE LOCAÇÃO RESIDENCIAL</h1>
<p style="text-align:center;color:#888;font-size:12px">Emitido por iLocarPay — ${new Date().toLocaleDateString('pt-BR')}</p>

<h2>1. Das Partes</h2>
<div class="parties">
  <div class="row">
    <div class="field"><div class="label">Locador / Imobiliária</div><div class="value">${data.ownerName || '—'}</div></div>
    <div class="field"><div class="label">CNPJ / CPF</div><div class="value">${data.ownerCpf || '—'}</div></div>
  </div>
  <div class="row" style="margin-top:16px">
    <div class="field"><div class="label">Locatário (Inquilino)</div><div class="value">${data.tenantName || '—'}</div></div>
    <div class="field"><div class="label">CPF</div><div class="value">${data.tenantCpf || '—'}</div></div>
  </div>
  <div class="row">
    <div class="field"><div class="label">E-mail</div><div class="value">${data.tenantEmail || '—'}</div></div>
    <div class="field"><div class="label">Telefone</div><div class="value">${data.tenantPhone || '—'}</div></div>
  </div>
</div>

<h2>2. Do Imóvel</h2>
<p><strong>Endereço:</strong> ${data.propertyAddress || '—'}</p>
<p><strong>Código do Imóvel:</strong> <span class="highlight">${data.propertyCode || '—'}</span></p>

<h2>3. Do Prazo e Valor</h2>
<p><strong>Vigência:</strong> ${fmtDate(data.startDate)} a ${fmtDate(data.endDate)}</p>
<p><strong>Aluguel mensal:</strong> <span class="highlight">${fmt(data.baseRent)}</span></p>
<p><strong>Vencimento:</strong> Todo dia <strong>${data.dueDay || 10}</strong> de cada mês.</p>
${data.deposit ? `<p><strong>Caução:</strong> ${fmt(data.deposit)}</p>` : ''}

<h2>4. Das Obrigações do Locatário</h2>
<p>O locatário se obriga a pagar pontualmente o aluguel na data convencionada, conservar o imóvel em bom estado de limpeza e conservação, não efetuar obras ou modificações sem anuência prévia do locador, e restituir o imóvel no estado em que o recebeu ao término do contrato.</p>

<h2>5. Das Obrigações do Locador</h2>
<p>O locador se obriga a entregar o imóvel em condições de uso, manter a posse mansa e pacífica do imóvel durante a locação, e responder pelos vícios ou defeitos anteriores à locação.</p>

<h2>6. Da Rescisão</h2>
<p>O contrato pode ser rescindido por qualquer das partes mediante notificação prévia de 30 (trinta) dias. A rescisão sem justa causa pelo locatário antes do prazo implica multa proporcional ao período restante.</p>

<h2>7. Do Foro</h2>
<p>As partes elegem o foro da comarca do imóvel locado para dirimir quaisquer controvérsias oriundas deste contrato.</p>

<div class="sign-area">
  <div class="sign-box">
    ${data.ownerName || 'Locador / Imobiliária'}<br>${data.ownerEmail || ''}
  </div>
  <div class="sign-box">
    ${data.tenantName || 'Locatário (Inquilino)'}<br>${data.tenantEmail || ''}
  </div>
</div>
</body></html>`;
}

// ── REGISTER BROKER ───────────────────────────────────────────────────────────

async function handleRegisterBroker(db, body) {
  const { ownerId, name, email, phone, commission } = body;
  if (!ownerId || !email) throw Object.assign(new Error('ownerId e email obrigatórios'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });
  const ownerData = ownerSnap.data();

  const emailNorm = email.toLowerCase().trim();
  const brokerName = name || emailNorm.split('@')[0];
  const commPct = parseFloat(commission) || 5;

  const id = emailNorm.replace(/[^a-z0-9]/g, '_') + '_' + ownerId.slice(0, 6);
  await db.collection('brokers').doc(id).set({
    ownerId,
    name: brokerName,
    email: emailNorm,
    phone: phone || '',
    active: true,
    commission: commPct,
    commissionPct: commPct,
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true });

  // Adiciona ao users também para login OTP
  const userRef = db.collection('users').doc(id);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      ownerId, name: brokerName,
      email: emailNorm, phone: phone || '',
      role: 'broker', active: true, createdAt: FieldValue.serverTimestamp()
    });
  }

  // Email de boas-vindas ao corretor (fire-and-forget)
  sendWelcomeBrokerEmail({ brokerName, brokerEmail: emailNorm, ownerName: ownerData.name || 'sua imobiliária' })
    .catch(e => console.warn('[register-broker] email erro:', e.message));

  return { ok: true, brokerId: id };
}

async function sendWelcomeBrokerEmail({ brokerName, brokerEmail, ownerName }) {
  const firstName = brokerName.split(' ')[0];
  await sendEmail(
    brokerEmail,
    `Você foi adicionado como corretor — ${ownerName}`,
    `
    <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
      <div style="margin-bottom:20px">
        <span style="font-weight:900;font-size:20px;color:#4CAF50">● iLocarPay</span>
      </div>
      <h2 style="color:#1a1a1a;margin-bottom:8px;font-size:20px">Olá, ${firstName}! 👋</h2>
      <p style="color:#555;line-height:1.7;margin-bottom:20px">
        Você foi cadastrado como <strong>corretor</strong> na imobiliária <strong>${ownerName}</strong> na plataforma iLocarPay.
      </p>
      <div style="background:#f0f7f0;border-radius:10px;padding:20px;margin-bottom:24px">
        <h3 style="color:#2e7d32;font-size:14px;margin-bottom:12px;margin-top:0">Como acessar o app</h3>
        <ol style="color:#555;line-height:2;padding-left:20px;margin:0">
          <li>Baixe o app <strong>iLocarPay</strong> para Android</li>
          <li>Na tela de login, informe seu e-mail: <strong>${brokerEmail}</strong></li>
          <li>Você receberá um código de acesso por e-mail</li>
          <li>Digite o código e pronto — você já está dentro!</li>
        </ol>
      </div>
      <a href="https://www.ilocarpay.com.br/download" style="display:inline-block;background:#4CAF50;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:24px">
        📲 Baixar o app agora
      </a>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#aaa;font-size:12px;margin:0">
        Dúvidas? Entre em contato com <strong>${ownerName}</strong>.<br>
        Este convite foi enviado automaticamente pela plataforma iLocarPay.
      </p>
    </div>
    `
  );
}

// ── UPDATE BROKER ─────────────────────────────────────────────────────────────

async function handleUpdateBroker(db, body) {
  const { brokerId, name, phone, active, commission, creci, commissionPct } = body;
  if (!brokerId) throw Object.assign(new Error('brokerId obrigatório'), { status: 400 });
  const updates = {};
  if (name          !== undefined) updates.name          = name;
  if (phone         !== undefined) updates.phone         = phone;
  if (active        !== undefined) updates.active        = active;
  if (creci         !== undefined) updates.creci         = creci;
  // Normaliza: ambos os campos escrevem em commissionPct (campo canônico lido pelo app)
  if (commissionPct !== undefined) { const v = parseFloat(commissionPct) || 0; updates.commissionPct = v; updates.commission = v; }
  if (commission    !== undefined && commissionPct === undefined) { const v = parseFloat(commission) || 0; updates.commissionPct = v; updates.commission = v; }
  if (!Object.keys(updates).length) throw Object.assign(new Error('Nenhum campo para atualizar'), { status: 400 });
  await db.collection('brokers').doc(brokerId).update(updates);
  await db.collection('users').doc(brokerId).update({ name: updates.name ?? '', phone: updates.phone ?? '' }).catch(() => {});
  return { ok: true, brokerId };
}

// ── DELETE BROKER ─────────────────────────────────────────────────────────────

async function handleDeleteBroker(db, body) {
  const { brokerId } = body;
  if (!brokerId) throw Object.assign(new Error('brokerId obrigatório'), { status: 400 });
  await db.collection('brokers').doc(brokerId).delete();
  await db.collection('users').doc(brokerId).delete().catch(() => {});
  return { ok: true, brokerId };
}

// ── SUBMIT LEAD ───────────────────────────────────────────────────────────────

async function handleSubmitLead(db, body) {
  const { ownerId, brokerEmail, brokerName, tenant, spouse, landlord, property, guarantee, docs, propertyCode, propertyDescription } = body;
  if (!ownerId || !tenant?.email) throw Object.assign(new Error('Dados obrigatórios ausentes'), { status: 400 });

  const leadRef = db.collection('leads').doc();
  await leadRef.set({
    ownerId,
    brokerEmail: brokerEmail || '',
    brokerName:  brokerName  || '',
    tenant: {
      name:           tenant.name           || '',
      email:          tenant.email.toLowerCase().trim(),
      cpf:            tenant.cpf            || '',
      phone:          tenant.phone          || '',
      birthDate:      tenant.birthDate      || '',
      nationality:    tenant.nationality    || '',
      maritalStatus:  tenant.maritalStatus  || '',
      rg:             tenant.rg             || '',
      rgIssuer:       tenant.rgIssuer       || '',
      currentAddress: tenant.currentAddress || '',
      profession:     tenant.profession     || '',
      company:        tenant.company        || '',
      income:         tenant.income         || '',
      employmentType: tenant.employmentType || ''
    },
    landlord: landlord ? {
      name:  landlord.name  || '',
      cpf:   landlord.cpf   || '',
      email: (landlord.email || '').toLowerCase().trim(),
      phone: landlord.phone  || ''
    } : null,
    spouse:   spouse   || null,
    property: property || null,
    guarantee: guarantee || null,
    docs:                docs || [],
    propertyCode:        propertyCode || (property?.code) || '',
    propertyDescription: propertyDescription || '',
    status:    'pending',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  // Push notification para o owner
  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  const owner = ownerSnap.data() || {};
  if (owner.fcmToken) {
    try {
      await getMessaging().send({
        token: owner.fcmToken,
        notification: {
          title: '📋 Novo lead recebido',
          body:  `${brokerName || brokerEmail} enviou documentos de ${tenant.name || tenant.email}`
        }
      });
    } catch (_) {}
  }

  return { ok: true, leadId: leadRef.id };
}

// ── APPROVE LEAD ──────────────────────────────────────────────────────────────

async function handleApproveLead(db, body) {
  const { leadId, contractData, landlordOverride, skipAssinafy } = body;
  if (!leadId) throw Object.assign(new Error('leadId obrigatório'), { status: 400 });

  const leadRef  = db.collection('leads').doc(leadId);
  const leadSnap = await leadRef.get();
  if (!leadSnap.exists) throw Object.assign(new Error('Lead não encontrado'), { status: 404 });
  const lead = leadSnap.data();
  if (!lead.ownerId) throw Object.assign(new Error('ownerId ausente no lead'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(lead.ownerId).get();
  const owner = { id: lead.ownerId, ...ownerSnap.data() };

  // Cria ou atualiza usuário (inquilino)
  const tenantEmail = lead.tenant.email;
  let tenantId;
  const existing = await db.collection('users').where('email', '==', tenantEmail).where('role', '==', 'tenant').limit(1).get();
  if (!existing.empty) {
    tenantId = existing.docs[0].id;
    await db.collection('users').doc(tenantId).update({
      ownerId:  lead.ownerId,
      name:     lead.tenant.name,
      phone:    lead.tenant.phone,
      cpf:      lead.tenant.cpf,
      active:   false, // ainda não entregou as chaves
      updatedAt: FieldValue.serverTimestamp()
    });
  } else {
    const newUserRef = db.collection('users').doc();
    tenantId = newUserRef.id;
    await newUserRef.set({
      ownerId:   lead.ownerId,
      name:      lead.tenant.name,
      email:     tenantEmail,
      cpf:       lead.tenant.cpf,
      phone:     lead.tenant.phone,
      role:      'tenant',
      active:    false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  // Busca telefone do corretor na coleção brokers pelo email
  let brokerPhone = '';
  if (lead.brokerEmail) {
    try {
      const brokerSnap = await db.collection('brokers')
        .where('email', '==', lead.brokerEmail.toLowerCase().trim())
        .limit(1).get();
      if (!brokerSnap.empty) {
        brokerPhone = (brokerSnap.docs[0].data().phone || '').replace(/\D/g, '');
      }
    } catch (_) {}
  }

  // Cria contrato — usa contractData do modal quando fornecido; fallback para lead.property
  const cd  = contractData || {};
  const lp  = lead.property || {};
  const propAddr = cd.propertyAddress || buildAddr(lp) || lead.propertyDescription || '';

  // Usa dados do proprietário: override do modal > lead.landlord > fallback owner
  const landlordSrc   = landlordOverride?.name ? landlordOverride : (lead.landlord || {});
  const landlordName  = landlordSrc.name  || owner.name  || '';
  const landlordEmail = landlordSrc.email || owner.email || '';
  const landlordCpf   = landlordSrc.cpf   || owner.cpf   || owner.cnpj || '';
  const landlordPhone = landlordSrc.phone || owner.phone || '';

  const contractRef = db.collection('contracts').doc();
  const contractId  = contractRef.id;
  await contractRef.set({
    ownerId:             lead.ownerId,
    tenantId,
    tenantEmail,
    tenantName:          lead.tenant.name,
    tenantCpf:           lead.tenant.cpf,
    tenantPhone:         (lead.tenant.phone || '').replace(/\D/g, ''),
    landlordPhone:       landlordPhone.replace(/\D/g, ''),
    brokerEmail:         lead.brokerEmail || '',
    brokerName:          lead.brokerName  || '',
    brokerPhone,
    propertyCode:        lead.propertyCode || '',
    propertyDescription: lead.propertyDescription || '',
    propertyAddress:     propAddr,
    address:             propAddr,
    propertyLogradouro:  lp.street       || '',
    propertyNumero:      lp.number       || '',
    propertyBairro:      lp.neighborhood || '',
    propertyCidade:      lp.city         || '',
    propertyEstado:      lp.state        || '',
    baseRent:            cd.baseRent  || parseFloat(lp.rentValue)  || 0,
    dueDay:              cd.dueDay    || lp.dueDay    || 10,
    startDate:           cd.startDate || lp.startDate || '',
    endDate:             cd.endDate   || lp.endDate   || '',
    deposit:             cd.deposit   || parseFloat(lp.deposit)    || 0,
    landlordName,
    landlordEmail,
    landlordCpf,
    active:              false, // ativa só após entregar as chaves
    assinafyStatus:      'pending',
    contractStatus:      'AGUARDANDO_PROPRIETARIO',
    leadId,
    createdAt:           FieldValue.serverTimestamp(),
    updatedAt:           FieldValue.serverTimestamp()
  });

  // Se override fornecido, salva no lead para uso futuro
  if (landlordOverride?.name) {
    await leadRef.update({ landlord: landlordOverride });
  }

  // Aprova o lead ANTES do Assinafy — garante que o lead fica aprovado mesmo em caso de timeout
  await leadRef.update({
    status:         'approved',
    contractStatus: 'AGUARDANDO_PROPRIETARIO',
    tenantId,
    contractId,
    approvedAt:     FieldValue.serverTimestamp(),
    updatedAt:      FieldValue.serverTimestamp()
  });

  if (skipAssinafy) {
    console.log('[approve-lead] skipAssinafy=true — contrato criado sem enviar ao Assinafy');
    return { ok: true, contractId, assinafySkipped: true };
  }

  // Gera contrato no Assinafy (maxDuration=300s, sem race artificial)
  let assinafyResult = null;
  const assinafyPayload = {
    contractId,
    ownerName:    landlordName,
    ownerEmail:   landlordEmail,
    ownerCpf:     landlordCpf,
    tenantName:   lead.tenant.name,
    tenantEmail,
    tenantCpf:    lead.tenant.cpf,
    tenantPhone:  lead.tenant.phone,
    propertyCode:    lead.propertyCode,
    propertyAddress: propAddr,
    baseRent:  cd.baseRent  || parseFloat(lp.rentValue)  || 0,
    dueDay:    cd.dueDay    || lp.dueDay    || 10,
    startDate: cd.startDate || lp.startDate || '',
    endDate:   cd.endDate   || lp.endDate   || '',
    deposit:   cd.deposit   || parseFloat(lp.deposit)    || 0
  };
  try {
    assinafyResult = await createAssinafyContract(db, contractId, assinafyPayload);
    console.log(`[approve-lead] contrato enviado ao Assinafy`);
  } catch (e) {
    console.error(`[approve-lead] Assinafy falhou:`, e.message);
    try {
      await db.collection('contracts').doc(contractId).update({
        assinafyError:  e.message,
        assinafyStatus: 'error',
        updatedAt:      FieldValue.serverTimestamp()
      });
    } catch (_) {}
    try {
      const adminPhone = process.env.ADMIN_WHATSAPP || '5514996270111';
      await sendWhatsApp(adminPhone,
        `⚠️ iLocarPay: falha ao enviar contrato ${contractId} ao Assinafy.\nErro: ${e.message}\nAcesse o painel e clique em "Reenviar ao Assinafy".`
      ).catch(() => {});
    } catch (_) {}
  }

  // Dispara todos os envios em paralelo (não bloqueia a resposta entre si)
  if (!landlordEmail) console.warn('[approve-lead] landlordEmail vazio. owner.email:', owner.email, 'lead.landlord:', JSON.stringify(lead.landlord));

  const contractPdfParams = {
    contractId,
    ownerName:    landlordName,
    ownerEmail:   landlordEmail,
    ownerCpf:     landlordCpf,
    tenantName:   lead.tenant.name,
    tenantEmail,
    tenantCpf:    lead.tenant.cpf,
    propertyCode:    lead.propertyCode,
    propertyAddress: propAddr,
    baseRent:  cd.baseRent  || parseFloat(lp.rentValue)  || 0,
    dueDay:    cd.dueDay    || lp.dueDay    || 10,
    startDate: cd.startDate || lp.startDate || '',
    endDate:   cd.endDate   || lp.endDate   || '',
    deposit:   cd.deposit   || parseFloat(lp.deposit)    || 0
  };

  const propAddrWa = [lead.property?.street, lead.property?.number, lead.property?.neighborhood, lead.property?.city, lead.property?.state, lead.property?.cep ? `CEP ${lead.property.cep}` : ''].filter(Boolean).join(', ') || lead.propertyDescription || 'imóvel';

  await Promise.allSettled([
    Promise.resolve(), // PDF separado removido — proprietário recebe link de assinatura via Assinafy

    // E-mail boas-vindas ao inquilino
    (async () => {
      try {
        await sendEmail(tenantEmail, '🎉 Sua locação foi aprovada — iLocarPay', `
          <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
            <div style="background:#1a1a1a;padding:32px;text-align:center">
              <h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1>
              <p style="color:#ccc;margin:8px 0 0">Gestão inteligente de aluguéis</p>
            </div>
            <div style="padding:32px">
              <p style="font-size:18px;font-weight:bold;color:#1a1a1a">Parabéns, ${lead.tenant.name || 'inquilino'}! 🎉</p>
              <p style="color:#444"><strong>${owner.name || 'Sua imobiliária'}</strong> aprovou a sua locação.</p>
              ${propAddr ? `<div style="background:#f0f7f0;border-left:4px solid #4CAF50;padding:12px 16px;border-radius:4px;margin:16px 0"><strong>Imóvel:</strong> ${propAddr}</div>` : ''}
              <p style="color:#444">Você receberá o contrato por e-mail para assinar digitalmente. Acompanhe tudo pelo aplicativo:</p>
              <div style="text-align:center;margin:28px 0">
                <a href="https://www.ilocarpay.com.br/download"
                   style="background:#4CAF50;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
                  📱 Baixar app iLocarPay
                </a>
              </div>
              <p style="color:#888;font-size:13px">Após instalar, entre com o e-mail <strong>${tenantEmail}</strong> para acessar seu contrato e acompanhar as cobranças.</p>
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#aaa;font-size:12px;text-align:center">Equipe iLocarPay • <a href="https://www.ilocarpay.com.br" style="color:#4CAF50">ilocarpay.com.br</a></p>
            </div>
          </div>
        `);
        console.log('[approve-lead] e-mail boas-vindas enviado ao inquilino:', tenantEmail);
      } catch (e) { console.warn('[approve-lead] tenant email error:', e.message); }
    })(),

    // WhatsApp proprietário
    landlordPhone ? sendWhatsApp(landlordPhone,
      `Olá, ${landlordName}! 🏠\n\nA locação do imóvel *${propAddrWa}* foi aprovada pela imobiliária.\n\nVocê receberá um e-mail com o PDF do contrato e um link para assinatura digital. Verifique sua caixa de entrada (${landlordEmail}).\n\n— iLocarPay`,
      owner, lead.ownerId
    ).catch(e => console.warn('[approve-lead] whatsapp landlord:', e.message)) : Promise.resolve(),

    // WhatsApp inquilino
    lead.tenant.phone ? sendWhatsApp(lead.tenant.phone,
      `Parabéns, ${lead.tenant.name || 'inquilino'}! 🎉\n\nSua locação do imóvel *${propAddrWa}* foi aprovada!\n\nO contrato será assinado primeiro pelo proprietário. Assim que ele assinar, você receberá o link no seu e-mail (${tenantEmail}).\n\n📲 *Baixe o app iLocarPay:*\nhttps://www.ilocarpay.com.br/download`,
      owner, lead.ownerId
    ).catch(e => console.warn('[approve-lead] whatsapp tenant:', e.message)) : Promise.resolve(),

    // E-mail ao corretor
    lead.brokerEmail ? sendEmail(lead.brokerEmail, '✅ Lead aprovado — iLocarPay', `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#4CAF50">iLocarPay</h2>
        <p>Olá, <strong>${lead.brokerName || lead.brokerEmail}</strong>!</p>
        <p>O lead <strong>${lead.tenant.name}</strong> foi <strong style="color:#4CAF50">aprovado</strong>.</p>
        <p>O contrato foi enviado para assinatura digital. Após a assinatura de ambas as partes, as chaves poderão ser entregues.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px;text-align:center">Equipe iLocarPay</p>
      </div>
    `).catch(e => console.warn('[approve-lead] broker email:', e.message)) : Promise.resolve(),
  ]);

  return { ok: true, tenantId, contractId, assinafy: assinafyResult };
}

// ── GENERATE CONTRACT (Assinafy) ──────────────────────────────────────────────

async function createAssinafyContract(db, contractId, data) {
  const configSnap = await db.collection('config').doc('assinafy').get();
  const apiKey = configSnap.data()?.apiKey;
  if (!apiKey) throw new Error('Chave Assinafy não configurada em config/assinafy');

  const accountId = await getAssinafyAccount(apiKey);

  // Gera PDF do contrato em memória
  const pdfBuffer = await generateContractPdf(data);
  const form = new FormData();
  form.append('name', `Contrato de Locação — ${data.tenantName || contractId}`);
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'contrato.pdf');

  // Cria documento
  const docRes = await assinafyReq('POST', `accounts/${accountId}/documents`, form, apiKey);
  const documentId = docRes?.data?.id || docRes?.id;
  if (!documentId) throw new Error('Assinafy não retornou documentId: ' + JSON.stringify(docRes));

  // 2. Cria signatários (get-or-create)
  const [s1Id, s2Id] = await Promise.all([
    getOrCreateSigner(apiKey, accountId, data.ownerName  || 'Proprietário', data.ownerEmail),
    getOrCreateSigner(apiKey, accountId, data.tenantName || 'Inquilino',    data.tenantEmail),
  ]);
  if (!s1Id || !s2Id) throw new Error('Assinafy não retornou IDs dos signatários');
  if (s1Id === s2Id) throw new Error(`Proprietário e inquilino têm o mesmo e-mail (${data.ownerEmail}). Use e-mails diferentes para cada parte.`);

  // 3. Cria assignment (sequencial: proprietário step 1, inquilino step 2)
  // Assinafy auto-envia o e-mail de assinatura ao criar o assignment
  const assignRes = await assinafyReq('POST', `documents/${documentId}/assignments`, {
    method:  'virtual',
    message: `Por favor, assine o contrato de locação do imóvel ${data.propertyAddress || ''}.`.trim(),
    signers: [
      { id: s1Id, step: 1, action: 'sign', verification_method: 'Facial', notification_methods: ['Email'] },
      { id: s2Id, step: 2, action: 'sign', verification_method: 'Facial', notification_methods: ['Email'] }
    ]
  }, apiKey);
  const assignmentId = assignRes?.data?.id || assignRes?.id;
  console.log('[assinafy] assignment criado:', assignmentId);

  // Extrai URLs de assinatura do assignment (quando disponíveis)
  const signingUrls = assignRes?.data?.signing_urls || assignRes?.signing_urls || [];
  const ownerSignUrl  = signingUrls.find(u => u.signer_id === s1Id)?.url || null;
  const tenantSignUrl = signingUrls.find(u => u.signer_id === s2Id)?.url || null;

  // E-mail nosso ao proprietário (complementar ao e-mail automático do Assinafy)
  if (data.ownerEmail) {
    try {
      const btnSection = ownerSignUrl
        ? `<div style="text-align:center;margin:28px 0">
            <a href="${ownerSignUrl}" style="background:#4CAF50;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
              ✍️ Assinar contrato agora
            </a>
           </div>
           <p style="color:#888;font-size:13px">Após sua assinatura, o contrato será enviado ao inquilino para assinatura.</p>`
        : `<p style="color:#444">Você receberá o e-mail da <strong>Assinafy</strong> com o link de assinatura digital. Verifique também sua caixa de spam.</p>`;
      await sendEmail(data.ownerEmail, '📝 Contrato aguarda sua assinatura — iLocarPay', `
        <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
          <div style="background:#1a1a1a;padding:32px;text-align:center">
            <h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1>
          </div>
          <div style="padding:32px">
            <p>Olá, <strong>${data.ownerName || 'Proprietário'}</strong>!</p>
            <p>O contrato de locação do imóvel <strong>${data.propertyAddress || ''}</strong> está aguardando a sua assinatura digital.</p>
            ${btnSection}
          </div>
        </div>
      `);
      console.log('[assinafy] e-mail proprietário enviado para', data.ownerEmail);
    } catch (e) { console.warn('[assinafy] owner sign email error:', e.message); }
  }

  // Inquilino: avisa que o proprietário assina primeiro + link do app
  if (data.tenantEmail) {
    try {
      const signSection = tenantSignUrl
        ? `<div style="text-align:center;margin:20px 0">
            <a href="${tenantSignUrl}" style="background:#4CAF50;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
              ✍️ Assinar contrato agora
            </a>
           </div>`
        : `<p style="color:#444;margin:12px 0">O proprietário assina primeiro. Assim que ele concluir, você receberá o link de assinatura no seu e-mail automaticamente.</p>`;
      await sendEmail(data.tenantEmail, '📋 Seu contrato foi gerado — iLocarPay', `
        <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
          <div style="background:#1a1a1a;padding:32px;text-align:center">
            <h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1>
            <p style="color:#aaa;margin:6px 0 0;font-size:14px">Gestão inteligente de aluguéis</p>
          </div>
          <div style="padding:32px">
            <p style="font-size:16px">Olá, <strong>${data.tenantName || 'Inquilino'}</strong>! 🎉</p>
            <p style="color:#444">O contrato de locação do imóvel <strong>${data.propertyAddress || ''}</strong> foi gerado com sucesso.</p>
            ${signSection}
            <hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
            <p style="font-weight:700;margin-bottom:8px">📱 Acompanhe tudo pelo app iLocarPay</p>
            <p style="color:#444;font-size:14px;margin-bottom:16px">Baixe o app para acompanhar cobranças, contrato e enviar chamados de manutenção.</p>
            <div style="text-align:center;margin:20px 0">
              <a href="https://www.ilocarpay.com.br/download" style="background:#2E7D32;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
                📲 Baixar app iLocarPay
              </a>
            </div>
            <div style="background:#f0f7f0;border-radius:8px;padding:14px;font-size:13px;color:#444">
              <strong>Como acessar:</strong><br>
              1. Baixe o app pelo botão acima<br>
              2. Informe seu e-mail: <strong>${data.tenantEmail}</strong><br>
              3. Digite o código que chegará neste e-mail
            </div>
            <hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
            <p style="color:#aaa;font-size:12px;text-align:center">Equipe iLocarPay • <a href="https://www.ilocarpay.com.br" style="color:#4CAF50">ilocarpay.com.br</a></p>
          </div>
        </div>
      `);
      console.log('[assinafy] e-mail inquilino enviado para', data.tenantEmail);
    } catch (e) { console.warn('[assinafy] tenant email error:', e.message); }
  }

  // 7. Salva IDs no contrato
  await db.collection('contracts').doc(contractId).update({
    assinafyDocumentId:   documentId,
    assinafyAssignmentId: assignmentId || '',
    assinafySignerId1:    s1Id,
    assinafySignerId2:    s2Id,
    assinafyStatus:       'sent',
    updatedAt:            FieldValue.serverTimestamp()
  });

  return { documentId, assignmentId, ownerSignUrl };
}

async function handleGenerateContract(db, body) {
  const { contractId } = body;
  if (!contractId) throw Object.assign(new Error('contractId obrigatório'), { status: 400 });

  const contractSnap = await db.collection('contracts').doc(contractId).get();
  if (!contractSnap.exists) throw Object.assign(new Error('Contrato não encontrado'), { status: 404 });
  const c = contractSnap.data();

  const ownerSnap = await db.collection('owners').doc(c.ownerId).get();
  const owner = ownerSnap.data() || {};

  // Usa dados do proprietário do imóvel (landlord) quando disponíveis; fallback para dados da imobiliária
  const landlordName  = c.landlordName  || owner.name  || '';
  const landlordEmail = c.landlordEmail || owner.email || '';
  const landlordCpf   = c.landlordCpf   || owner.cpf   || owner.cnpj || '';
  const landlordPhone = (c.landlordPhone || owner.phone || '').replace(/\D/g, '');

  // Busca nome do inquilino se não estiver no contrato
  let tenantName = c.tenantName || '';
  let tenantCpf  = c.tenantCpf  || '';
  let tenantPhone = (c.tenantPhone || '').replace(/\D/g, '');
  if (!tenantName && c.tenantId) {
    try {
      const tSnap = await db.collection('users').doc(c.tenantId).get();
      if (tSnap.exists) {
        const t = tSnap.data();
        tenantName  = t.name  || '';
        tenantCpf   = t.cpf   || tenantCpf;
        tenantPhone = (t.phone || tenantPhone).replace(/\D/g, '');
      }
    } catch (_) {}
  }

  const contractPdfData = {
    contractId,
    ownerName:       landlordName,
    ownerEmail:      landlordEmail,
    ownerCpf:        landlordCpf,
    tenantName,
    tenantEmail:     c.tenantEmail,
    tenantCpf,
    propertyCode:    c.propertyCode,
    propertyAddress: c.propertyAddress || c.address || '',
    baseRent:  c.baseRent,
    dueDay:    c.dueDay,
    startDate: c.startDate,
    endDate:   c.endDate,
    deposit:   c.deposit || 0
  };

  let result = {};
  try {
    // Se já existe documento no Assinafy, anula-o antes de criar novo
    if (c.assinafyDocumentId) {
      const configSnap = await db.collection('config').doc('assinafy').get();
      const apiKey = configSnap.data()?.apiKey;
      if (apiKey) {
        try {
          await assinafyReq('DELETE', `documents/${c.assinafyDocumentId}`, null, apiKey);
          console.log('[generate-contract] documento anterior anulado:', c.assinafyDocumentId);
        } catch (e) {
          // Pode falhar se já estava anulado/expirado — continua mesmo assim
          console.warn('[generate-contract] falha ao anular doc anterior:', e.message);
        }
      }
      // Limpa referência antiga no Firestore antes de criar novo
      await db.collection('contracts').doc(contractId).update({
        assinafyDocumentId:   null,
        assinafyAssignmentId: null,
        assinafySignerId1:    null,
        assinafySignerId2:    null,
        assinafyStatus:       'pending',
        contractStatus:       'AGUARDANDO_PROPRIETARIO',
        updatedAt:            FieldValue.serverTimestamp()
      });
    }
    result = await createAssinafyContract(db, contractId, { ...contractPdfData, tenantPhone });
  } catch (e) {
    console.error('[generate-contract] Assinafy error:', e.message);
    throw Object.assign(new Error('Falha ao enviar ao Assinafy: ' + e.message), { status: 500 });
  }

  // Envia PDF do contrato por e-mail ao proprietário (sempre, independente da Assinafy)
  // E-mail com PDF em anexo removido — proprietário recebe link de assinatura via Assinafy

  // Salva phones no contrato para o webhook usar depois
  await db.collection('contracts').doc(contractId).update({
    landlordPhone, tenantPhone,
    updatedAt: FieldValue.serverTimestamp()
  });

  // WhatsApp ao proprietário do imóvel
  const addr = c.propertyAddress || c.address || c.propertyCode || 'o imóvel';
  if (landlordPhone) {
    await sendWhatsApp(landlordPhone,
      `Olá, ${landlordName}! 🏠\n\nUm contrato de locação do imóvel *${addr}* foi gerado e enviado para o seu e-mail (${landlordEmail}) para assinatura digital.\n\nPor favor, verifique sua caixa de entrada e assine o contrato para concluir a locação.\n\n— iLocarPay`,
      owner, c.ownerId
    );
  }

  // WhatsApp ao inquilino informando que o contrato vai ao proprietário primeiro
  if (tenantPhone) {
    await sendWhatsApp(tenantPhone,
      `Olá, ${tenantName}! 🎉\n\nO contrato de locação do imóvel *${addr}* foi gerado. Ele será assinado primeiro pelo proprietário. Assim que ele assinar, você receberá o contrato no seu e-mail (${c.tenantEmail}) para assinar digitalmente.\n\n— iLocarPay`,
      owner, c.ownerId
    );
  }

  return { ok: true, ...result };
}

// ── DELIVER KEYS ──────────────────────────────────────────────────────────────

async function handleCheckContractStatus(db, body) {
  const { contractId, assinafyDocumentId } = body;
  if (!contractId && !assinafyDocumentId) throw Object.assign(new Error('contractId ou assinafyDocumentId obrigatório'), { status: 400 });

  let contractSnap;
  if (contractId) {
    contractSnap = await db.collection('contracts').doc(contractId).get();
  } else {
    const q = await db.collection('contracts').where('assinafyDocumentId', '==', assinafyDocumentId).limit(1).get();
    contractSnap = q.empty ? null : q.docs[0];
  }
  if (!contractSnap || !contractSnap.exists) throw Object.assign(new Error('Contrato não encontrado'), { status: 404 });
  const c = contractSnap.data();

  const documentId   = c.assinafyDocumentId;
  const assignmentId = c.assinafyAssignmentId;
  const signerId1    = c.assinafySignerId1;
  const signerId2    = c.assinafySignerId2;
  if (!documentId || !assignmentId) return { contractStatus: c.contractStatus || 'AGUARDANDO_PROPRIETARIO', changed: false };

  const configSnap = await db.collection('config').doc('assinafy').get();
  const apiKey = configSnap.data()?.apiKey;
  if (!apiKey) return { contractStatus: c.contractStatus, changed: false };

  // Busca o documento — o Assinafy embute info de assignment dentro de data.assignment
  const docData = await assinafyReq('GET', `documents/${documentId}`, null, apiKey);
  const docInner = docData?.data || docData;
  // assignment pode estar em data.assignment ou data.assignments[0]
  const assignDetail = docInner?.assignment || (docInner?.assignments || [])[0] || {};
  const signers = assignDetail?.signers || [];
  const s1 = signers.find(s => s.id === signerId1) || signers.find(s => s.step === 1);
  const s2 = signers.find(s => s.id === signerId2) || signers.find(s => s.step === 2);
  const s1Signed = s1?.completed || s1?.signed_at != null;
  const s2Signed = s2?.completed || s2?.signed_at != null;

  let newStatus = c.contractStatus || 'AGUARDANDO_PROPRIETARIO';
  let changed = false;

  if (s1Signed && s2Signed && newStatus !== 'CONTRATO_ASSINADO') {
    newStatus = 'CONTRATO_ASSINADO';
    changed = true;
  } else if (s1Signed && !s2Signed && newStatus === 'AGUARDANDO_PROPRIETARIO') {
    newStatus = 'AGUARDANDO_INQUILINO';
    changed = true;
    // Envia e-mail ao inquilino com link de assinatura
    const signingUrls = assignDetail?.data?.signing_urls || [];
    const tenantUrl   = signingUrls.find(u => u.signer_id === signerId2)?.url || null;
    if (tenantUrl && c.tenantEmail) {
      try {
        await sendEmail(c.tenantEmail, '📝 Contrato aguarda sua assinatura — iLocarPay', `
          <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
            <div style="background:#1a1a1a;padding:32px;text-align:center"><h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1></div>
            <div style="padding:32px">
              <p>Olá, <strong>${c.tenantName || 'Inquilino'}</strong>!</p>
              <p>O proprietário assinou o contrato. Agora é a sua vez!</p>
              <div style="text-align:center;margin:28px 0">
                <a href="${tenantUrl}" style="background:#4CAF50;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">✍️ Assinar contrato agora</a>
              </div>
            </div>
          </div>
        `);
      } catch (e) { console.warn('[check-status] email inquilino:', e.message); }
    }
  }

  // Sempre garante assinafyStatus = 'completed' quando ambos assinaram
  if (s1Signed && s2Signed && c.assinafyStatus !== 'completed') {
    await contractSnap.ref.update({ assinafyStatus: 'completed', updatedAt: FieldValue.serverTimestamp() });
  }
  if (changed) {
    const contractUpdates = { contractStatus: newStatus, updatedAt: FieldValue.serverTimestamp() };
    if (newStatus === 'CONTRATO_ASSINADO') contractUpdates.assinafyStatus = 'completed';
    await contractSnap.ref.update(contractUpdates);
    if (c.leadId) {
      const updates = { contractStatus: newStatus, updatedAt: FieldValue.serverTimestamp() };
      if (newStatus === 'CONTRATO_ASSINADO') updates.bothSigned = true;
      await db.collection('leads').doc(c.leadId).update(updates);
    }
  }

  return { contractStatus: newStatus, changed, s1Signed, s2Signed };
}

async function handleDeliverKeys(db, body) {
  const { contractId, tenantId } = body;
  if (!contractId || !tenantId) throw Object.assign(new Error('contractId e tenantId obrigatórios'), { status: 400 });

  await Promise.all([
    db.collection('contracts').doc(contractId).update({
      active:           true,
      contractStatus:   'CHAVES_ENTREGUES',
      keysDeliveredAt:  FieldValue.serverTimestamp(),
      updatedAt:        FieldValue.serverTimestamp()
    }),
    db.collection('users').doc(tenantId).update({
      active:    true,
      activatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    })
  ]);

  // Atualiza lead com status final (lido em tempo real pelo app do corretor)
  try {
    const leads = await db.collection('leads').where('contractId', '==', contractId).limit(1).get();
    if (!leads.empty) {
      await leads.docs[0].ref.update({
        status:         'delivered',
        contractStatus: 'CHAVES_ENTREGUES',
        updatedAt:      FieldValue.serverTimestamp()
      });
    }
  } catch (_) {}

  // Push notification ao inquilino
  await sendPush(db, tenantId,
    '🏠 Bem-vindo ao seu novo lar!',
    'As chaves foram entregues. Acesse o app para ver seu contrato e cobranças.'
  );

  return { ok: true };
}

// ── REJECT LEAD ───────────────────────────────────────────────────────────────

async function handleRemoveLead(db, body) {
  const { leadId } = body;
  if (!leadId) throw Object.assign(new Error('leadId obrigatório'), { status: 400 });
  await db.collection('leads').doc(leadId).delete();
  return { ok: true };
}

async function handleRejectLead(db, body) {
  const { leadId, reason } = body;
  if (!leadId) throw Object.assign(new Error('leadId obrigatório'), { status: 400 });

  const leadSnap = await db.collection('leads').doc(leadId).get();
  if (!leadSnap.exists) throw Object.assign(new Error('Lead não encontrado'), { status: 404 });
  const lead = leadSnap.data();

  await db.collection('leads').doc(leadId).update({
    status: 'rejected', rejectionReason: reason || '',
    rejectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });

  if (lead.brokerEmail) {
    try {
      await sendEmail(lead.brokerEmail, '❌ Lead não aprovado — iLocarPay', `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#ef5350">iLocarPay</h2>
          <p>Olá, <strong>${lead.brokerName || lead.brokerEmail}</strong>!</p>
          <p>O lead <strong>${lead.tenant?.name}</strong> não foi aprovado pela imobiliária.</p>
          ${reason ? `<p><strong>Motivo:</strong> ${reason}</p>` : ''}
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px;text-align:center">Equipe iLocarPay</p>
        </div>
      `);
    } catch (_) {}
  }

  const prop    = lead.property || {};
  const addr    = [prop.street, prop.number, prop.city].filter(Boolean).join(', ') || lead.propertyDescription || 'o imóvel';
  const tenant  = lead.tenant   || {};

  let rejectOwnerData = null;
  if (lead.ownerId) {
    const os = await db.collection('owners').doc(lead.ownerId).get().catch(() => null);
    rejectOwnerData = os?.exists ? os.data() : null;
  }

  // WhatsApp ao inquilino — neutro, sem expor motivo
  if (tenant.phone) {
    await sendWhatsApp(tenant.phone,
      `Olá, ${tenant.name || 'inquilino'}.\n\nInformamos que sua proposta de locação para o imóvel *${addr}* não foi aprovada neste momento.\n\nPara mais informações, entre em contato com a imobiliária responsável.\n\n— iLocarPay`,
      rejectOwnerData, lead.ownerId
    );
  }

  // WhatsApp ao proprietário
  if (lead.landlordPhone) {
    await sendWhatsApp(lead.landlordPhone,
      `Olá! Informamos que a proposta de locação do imóvel *${addr}* não foi aprovada pela imobiliária neste momento.\n\n— iLocarPay`,
      rejectOwnerData, lead.ownerId
    );
  }

  return { ok: true };
}

// ── WHATSAPP (por owner) ──────────────────────────────────────────────────────

function getEvoConfig(ownerData, ownerId) {
  // Credenciais: usa do owner se configuradas, senão usa globais (servidor compartilhado)
  const baseUrl = (ownerData?.evolutionApiUrl || process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  const apiKey  = ownerData?.evolutionApiKey  || process.env.EVOLUTION_API_KEY  || '';
  // Instância: usa do owner se configurada; senão gera automaticamente a partir do ownerId
  const instance = ownerData?.evolutionInstance
    || (ownerId ? `owner_${ownerId.slice(0, 12).replace(/[^a-zA-Z0-9]/g, '')}` : process.env.EVOLUTION_INSTANCE || '');
  return { baseUrl, apiKey, instance };
}

function makeEvoFetch(baseUrl, apiKey) {
  return (path, opts = {}) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 25000);
    return fetch(`${baseUrl}/${path}`, {
      ...opts,
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
  };
}

async function ensureEvoInstance(evoFetch, instance) {
  // Cria instância se não existir
  try {
    const r = await evoFetch(`instance/create`, {
      method: 'POST',
      body: JSON.stringify({ instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
    });
    const d = await r.json().catch(() => ({}));
    console.log('[evo] create instance:', JSON.stringify(d).slice(0, 200));
  } catch (e) {
    console.warn('[evo] create instance error (pode já existir):', e.message);
  }
}

async function handleWhatsappQr(db, body) {
  const rawId = body.ownerId;
  const ownerId = (rawId && typeof rawId === 'string' && rawId !== 'undefined' && rawId.trim()) ? rawId.trim() : null;

  let ownerData = null;
  if (ownerId) {
    const snap = await db.collection('owners').doc(ownerId).get();
    ownerData = snap.exists ? snap.data() : null;
  }

  const { baseUrl, apiKey, instance } = getEvoConfig(ownerData, ownerId);
  if (!baseUrl || !apiKey) {
    throw Object.assign(new Error('Evolution API não configurada no servidor'), { status: 500 });
  }

  // Indica se esta instância já estava vinculada a este owner antes desta chamada
  const instanceAlreadyRegistered = !!(ownerData?.evolutionInstance);

  // Persiste a instância no owner se ainda não estava salva
  if (ownerId && ownerData && !ownerData.evolutionInstance) {
    await db.collection('owners').doc(ownerId).update({ evolutionInstance: instance })
      .then(() => console.log(`[whatsapp-qr] evolutionInstance salvo: ${instance} → owner ${ownerId}`))
      .catch(e => console.error(`[whatsapp-qr] ERRO ao salvar evolutionInstance:`, e.message, e.code));
  }

  const evoFetch = makeEvoFetch(baseUrl, apiKey);

  // Verifica estado da instância
  const statusRes = await evoFetch(`instance/connectionState/${instance}`);
  const statusText = await statusRes.text();
  let statusData;
  try { statusData = JSON.parse(statusText); } catch { statusData = {}; }
  const state = statusData?.instance?.state || statusData?.state;
  console.log(`[whatsapp-qr] ownerId=${ownerId} instance=${instance} state=${state} registered=${instanceAlreadyRegistered}`);

  if (state === 'open' && instanceAlreadyRegistered) {
    // Só considera conectado se esta instância já estava vinculada a este owner
    if (ownerId) {
      await db.collection('owners').doc(ownerId).update({
        whatsappConnected: true,
        whatsappInstance: instance,
        whatsappConnectedAt: new Date().toISOString(),
      }).catch(() => {});
    }
    return { ok: true, connected: true, instance };
  }

  // Instância não existe (404), não está open, ou é recém-gerada — cria/reconecta
  const needsCreate = statusRes.status === 404 || !state || (state === 'open' && !instanceAlreadyRegistered);
  // Instância travada em "connecting" ou "close" — deletar e recriar do zero
  const isStuck = state === 'connecting' || state === 'close';
  if (needsCreate || isStuck) {
    if (isStuck) {
      console.log(`[whatsapp-qr] instância ${instance} travada (${state}) — deletando para recriar`);
      // Tenta logout e delete ignorando qualquer erro — servidor pode rejeitar/abortar
      try { await evoFetch(`instance/logout/${instance}`, { method: 'DELETE' }); } catch {}
      await sleep(500);
      try { await evoFetch(`instance/delete/${instance}`, { method: 'DELETE' }); } catch {}
      await sleep(800);
    }
    // Cria instância — ignora erro 403 "já existe" (ensureEvoInstance já trata isso)
    await ensureEvoInstance(evoFetch, instance);
    await sleep(2000);
  }

  // Busca QR Code — tenta até 2 vezes se vier vazio
  let base64 = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const qrRes  = await evoFetch(`instance/connect/${instance}`);
    const qrText = await qrRes.text();
    let qrData = {};
    try { qrData = JSON.parse(qrText); } catch {}
    console.log(`[whatsapp-qr] connect attempt ${attempt + 1}:`, JSON.stringify(qrData).slice(0, 300));
    base64 = qrData?.base64 || qrData?.qrcode?.base64 || qrData?.code
          || qrData?.data?.base64 || qrData?.data?.qrcode?.base64;
    if (base64) break;
    if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
  }

  return { ok: true, connected: false, base64, state, instance };
}

async function handleWhatsappDisconnect(db, body) {
  const rawId = body.ownerId;
  const ownerId = (rawId && typeof rawId === 'string' && rawId !== 'undefined' && rawId.trim()) ? rawId.trim() : null;
  let ownerData = null;
  if (ownerId) {
    const snap = await db.collection('owners').doc(ownerId).get();
    ownerData = snap.exists ? snap.data() : null;
  }
  const { baseUrl, apiKey, instance } = getEvoConfig(ownerData, ownerId);
  if (!baseUrl || !apiKey || !instance) throw Object.assign(new Error('Evolution API não configurada'), { status: 500 });
  const evoFetch = makeEvoFetch(baseUrl, apiKey);
  await evoFetch(`instance/logout/${instance}`, { method: 'DELETE' }).catch(() => {});
  if (ownerId) {
    await db.collection('owners').doc(ownerId).update({ whatsappConnected: false }).catch(() => {});
  }
  return { ok: true };
}

async function handleWaKeepalive(db) {
  // Lê todos os owners com whatsappConnected=true e evolutionInstance configurado
  const snap = await db.collection('owners')
    .where('whatsappConnected', '==', true)
    .get();
  const results = [];
  await Promise.all(snap.docs.map(async (doc) => {
    const owner = doc.data();
    const ownerId = doc.id;
    const { baseUrl, apiKey, instance } = getEvoConfig(owner, ownerId);
    if (!baseUrl || !apiKey || !instance) return;
    const evoFetch = makeEvoFetch(baseUrl, apiKey);
    try {
      const stateRes = await evoFetch(`instance/connectionState/${instance}`);
      const stateData = await stateRes.json().catch(() => ({}));
      const state = stateData?.instance?.state || stateData?.state || 'close';
      if (state === 'open') {
        results.push({ ownerId, instance, state: 'open' });
      } else {
        // Tenta reconectar (restaura sessão salva ou retorna QR)
        await evoFetch(`instance/connect/${instance}`).catch(() => {});
        // Aguarda 3s e verifica novamente
        await new Promise(r => setTimeout(r, 3000));
        const s2Res = await evoFetch(`instance/connectionState/${instance}`).catch(() => null);
        const s2Data = s2Res ? await s2Res.json().catch(() => ({})) : {};
        const state2 = s2Data?.instance?.state || s2Data?.state || 'close';
        const nowConnected = state2 === 'open';
        if (!nowConnected) {
          // Marca como desconectado no Firestore para que o admin veja na UI
          await db.collection('owners').doc(ownerId).update({ whatsappConnected: false }).catch(() => {});
        }
        results.push({ ownerId, instance, state: state2, wasDisconnected: true, nowConnected });
        console.log(`[wa-keepalive] ${ownerId} ${instance} was=${state} now=${state2}`);
      }
    } catch (e) {
      results.push({ ownerId, instance, error: e.message });
    }
  }));
  return { ok: true, checked: results.length, results };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

async function handleGetSignedReadUrl(body) {
  const { path, adminEmail } = body;
  if (!path) throw Object.assign(new Error('path obrigatório'), { status: 400 });
  if (!adminEmail) throw Object.assign(new Error('Acesso não autorizado'), { status: 403 });
  const storage = getStorage();
  const bucketName = 'transgu-web-6d50f.firebasestorage.app';
  const file = storage.bucket(bucketName).file(path);
  // Tenta URL assinada; se falhar (falta iam.signBlob), retorna URL de download via Admin SDK
  try {
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000,
    });
    return { ok: true, url };
  } catch (_) {
    // Fallback: gera token de download via Admin SDK (não requer signBlob)
    const [meta] = await file.getMetadata();
    const token = meta?.metadata?.firebaseStorageDownloadTokens;
    if (token) {
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
      return { ok: true, url };
    }
    // Último recurso: lê o arquivo e retorna base64
    const [buf] = await file.download();
    const mime = meta?.contentType || 'application/octet-stream';
    return { ok: true, url: `data:${mime};base64,${buf.toString('base64')}` };
  }
}

async function handleGetChatUploadUrl(body, bucket) {
  const { ownerId, chatId, fileName, contentType } = body;
  if (!ownerId || !fileName) throw Object.assign(new Error('ownerId e fileName obrigatórios'), { status: 400 });
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeChatId = (chatId || ownerId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = `chat/${safeChatId}/${Date.now()}_${safeName}`;
  const storage = getStorage();
  const bucketName = bucket || 'transgu-web-6d50f.firebasestorage.app';
  const file = storage.bucket(bucketName).file(path);
  try {
    const signedOpts = { action: 'write', expires: Date.now() + 30 * 60 * 1000, version: 'v4' };
    if (contentType) signedOpts.contentType = contentType;
    const [signedUrl] = await file.getSignedUrl(signedOpts);
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${path}`;
    return { ok: true, uploadUrl: signedUrl, publicUrl, path };
  } catch (e) {
    throw Object.assign(new Error('Erro ao gerar URL de upload: ' + e.message), { status: 500 });
  }
}

async function handleConfirmChatUpload(body, bucket) {
  const { path } = body;
  if (!path) throw Object.assign(new Error('path obrigatório'), { status: 400 });
  const bucketName = bucket || 'transgu-web-6d50f.firebasestorage.app';
  const file = getStorage().bucket(bucketName).file(path);
  await file.makePublic();
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${path}`;
  return { ok: true, publicUrl };
}

async function handleGetUploadUrl(body, bucket) {
  const { ownerId, fileName, contentType } = body;
  if (!ownerId || !fileName) throw Object.assign(new Error('ownerId e fileName obrigatórios'), { status: 400 });
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `leads/${ownerId}/${Date.now()}_${safeName}`;
  const storage = getStorage();
  const bucketName = bucket || 'transgu-web-6d50f.firebasestorage.app';
  const file = storage.bucket(bucketName).file(path);
  try {
    const signedOpts = {
      action: 'write',
      expires: Date.now() + 30 * 60 * 1000, // 30 min (PDFs grandes demoram mais)
      version: 'v4',
    };
    if (contentType) signedOpts.contentType = contentType;
    const [signedUrl] = await file.getSignedUrl(signedOpts);
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${path}`;
    console.log('[get-upload-url] signed URL ok para', path, 'contentType:', contentType || 'any');
    return { ok: true, uploadUrl: signedUrl, publicUrl, path };
  } catch (e) {
    console.error('[get-upload-url] getSignedUrl falhou:', e.message);
    throw Object.assign(new Error('Erro ao gerar URL de upload: ' + e.message), { status: 500 });
  }
}

async function handleUploadDoc(db, body) {
  const { ownerId, fileName, contentType, data } = body;
  if (!ownerId || !fileName || !data) throw Object.assign(new Error('Dados obrigatórios ausentes'), { status: 400 });
  const mime = contentType || 'image/jpeg';
  const BUCKET = 'transgu-web-6d50f.firebasestorage.app';

  try {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `leads/${ownerId}/${Date.now()}_${safeName}`;
    const buffer = Buffer.from(data, 'base64');
    const storage = getStorage();
    const file = storage.bucket(BUCKET).file(path);
    await file.save(buffer, { contentType: mime, resumable: false });
    // Não chamar makePublic() — arquivo fica privado, acessível só via URL assinada
    const publicUrl = `https://storage.googleapis.com/${BUCKET}/${path}`;
    return { ok: true, publicUrl, path };
  } catch (storageErr) {
    console.warn('[upload-doc] storage falhou, fallback Firestore:', storageErr.message);
    // Fallback: salva base64 no Firestore
    const docRef = db.collection('doc_uploads').doc();
    await docRef.set({ ownerId, fileName, mime, data, createdAt: FieldValue.serverTimestamp() });
    const publicUrl = `data:${mime};base64,${data}`;
    return { ok: true, publicUrl, path: docRef.id };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Safety net: garante JSON mesmo em erros inesperados
  res.setHeader('Content-Type', 'application/json');

  // GET: serve HTML do contrato para Assinafy
  // Evolution API webhook — connection.update events
  if (req.method === 'POST' && req.query?.webhook === 'evolution') {
    const event = req.body?.event || '';
    const state = req.body?.data?.state || '';
    if (event === 'connection.update' && (state === 'close' || state === 'refused')) {
      const baseUrl  = process.env.EVOLUTION_API_URL;
      const apiKey   = process.env.EVOLUTION_API_KEY;
      const instance = process.env.EVOLUTION_INSTANCE;
      const adminPhone = process.env.ADMIN_WHATSAPP || '5514996270111';
      if (baseUrl && apiKey && instance) {
        const msg = `⚠️ *iLocarPay* - WhatsApp desconectado!\n\nInstância "${instance}" status: *${state}*.\n\nAcesse o painel para reconectar via QR code.`;
        fetch(`${baseUrl}/message/sendText/${instance}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: apiKey },
          body: JSON.stringify({ number: adminPhone, text: msg }),
        }).catch(() => {});
      }
    }
    return res.status(200).json({ ok: true });
  }

  // Webhook da Assinafy
  if (req.method === 'POST' && req.query?.webhook === 'assinafy') {
    try {
      initFirebase();
      const db = getFirestore();
      const event      = req.body?.event || req.body?.type || '';
      const documentId = req.body?.data?.document_id || req.body?.document_id || req.body?.data?.id || '';
      const signerStep = req.body?.data?.signer?.step ?? req.body?.data?.step ?? null;
      console.log('[assinafy-webhook] event:', event, 'documentId:', documentId, 'step:', signerStep, 'body:', JSON.stringify(req.body).slice(0, 400));

      const isSignerSigned = event === 'signer_signed_document';
      const isCompleted    = event === 'document_ready' || event === 'document.completed' || event === 'finished';

      if ((isSignerSigned || isCompleted) && documentId) {
        let contractSnap = await db.collection('contracts')
          .where('assinafyDocumentId', '==', documentId).limit(1).get();
        if (contractSnap.empty) {
          console.warn('[assinafy-webhook] contrato NÃO encontrado por assinafyDocumentId:', documentId);
          // Fallback: tenta pelo e-mail do signatário no payload
          const signerEmail = req.body?.event?.signer?.email || req.body?.signer?.email || null;
          if (signerEmail) {
            const fallback = await db.collection('contracts')
              .where('tenantEmail', '==', signerEmail).orderBy('createdAt', 'desc').limit(1).get();
            if (!fallback.empty) {
              contractSnap = fallback;
              console.log('[assinafy-webhook] contrato encontrado via tenantEmail fallback:', signerEmail);
            }
          }
        }
        if (!contractSnap.empty) {
          const contractDoc  = contractSnap.docs[0];
          const contractData = contractDoc.data();

          if (isCompleted) {
            console.log('[assinafy-webhook] document_ready → atualizando contrato', contractDoc.id);
            await contractDoc.ref.update({ assinafyStatus: 'completed', contractStatus: 'CONTRATO_ASSINADO', updatedAt: FieldValue.serverTimestamp() });
            const leadId = contractData.leadId;
            if (leadId) {
              await db.collection('leads').doc(leadId).update({ bothSigned: true, contractStatus: 'CONTRATO_ASSINADO', updatedAt: FieldValue.serverTimestamp() });
            }
          }

          // Proprietário assinou (step 1) → busca URL do inquilino e envia e-mail
          if (isSignerSigned && (signerStep === 1 || signerStep === null)) {
            await contractDoc.ref.update({ contractStatus: 'AGUARDANDO_INQUILINO', updatedAt: FieldValue.serverTimestamp() });
            // Busca URL de assinatura do inquilino (step 2) na Assinafy
            const configSnap = await db.collection('config').doc('assinafy').get();
            const apiKey = configSnap.data()?.apiKey;
            if (apiKey && contractData.assinafyAssignmentId) {
              try {
                const acctId = await getAssinafyAccount(apiKey);
                const assignDetail = await assinafyReq('GET', `accounts/${acctId}/documents/${documentId}/assignments/${contractData.assinafyAssignmentId}`, null, apiKey);
                const signingUrls  = assignDetail?.data?.signing_urls || assignDetail?.signing_urls || [];
                const tenantUrl    = signingUrls.find(u => u.signer_id === contractData.assinafySignerId2)?.url || null;
                if (tenantUrl && contractData.tenantEmail) {
                  await sendEmail(contractData.tenantEmail, '📝 Contrato aguarda sua assinatura — iLocarPay', `
                    <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
                      <div style="background:#1a1a1a;padding:32px;text-align:center"><h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1></div>
                      <div style="padding:32px">
                        <p>Olá, <strong>${contractData.tenantName || 'Inquilino'}</strong>!</p>
                        <p>O proprietário assinou o contrato. Agora é a sua vez!</p>
                        <div style="text-align:center;margin:28px 0">
                          <a href="${tenantUrl}" style="background:#4CAF50;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">✍️ Assinar contrato agora</a>
                        </div>
                      </div>
                    </div>
                  `);
                  console.log('[assinafy-webhook] e-mail inquilino enviado para', contractData.tenantEmail);
                }
              } catch (e) { console.warn('[assinafy-webhook] erro ao buscar URL inquilino:', e.message); }
            }
          }
        }
      }
    } catch (e) { console.warn('[assinafy-webhook]', e.message); }
    return res.status(200).json({ ok: true });
  }

async function handleCronRetryAssinafy(db) {
  // Busca contratos com erro Assinafy criados nas últimas 48h
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const snap = await db.collection('contracts')
    .where('assinafyStatus', '==', 'error')
    .where('createdAt', '>=', cutoff)
    .limit(10)
    .get();
  if (snap.empty) return { retried: 0 };

  let retried = 0, failed = 0;
  for (const contractSnap of snap.docs) {
    const contractId = contractSnap.id;
    const c = contractSnap.data();
    // Não retentar se já foi enviado por outro caminho
    if (c.assinafyDocumentId) continue;
    try {
      // Busca lead para reconstruir os dados
      const leadsSnap = await db.collection('leads').where('contractId', '==', contractId).limit(1).get();
      if (leadsSnap.empty) continue;
      const lead = leadsSnap.docs[0].data();
      const t = lead.tenant || {};
      const p = lead.property || {};
      const landlord = lead.landlord || {};
      const propAddr = buildAddr(p);
      await createAssinafyContract(db, contractId, {
        contractId,
        ownerName:       landlord.name       || c.landlordName    || '',
        ownerEmail:      landlord.email      || c.landlordEmail   || '',
        ownerCpf:        landlord.cpf        || c.landlordCpf     || '',
        tenantName:      t.name              || c.tenantName      || '',
        tenantEmail:     t.email             || c.tenantEmail     || '',
        tenantCpf:       t.cpf               || '',
        tenantPhone:     t.phone             || '',
        propertyCode:    lead.propertyCode   || p.code            || '',
        propertyAddress: propAddr            || c.propertyAddress || '',
        baseRent:        c.baseRent          || parseFloat(p.rentValue) || 0,
        dueDay:          c.dueDay            || p.dueDay          || 10,
        startDate:       c.startDate         || p.startDate       || '',
        endDate:         c.endDate           || p.endDate         || '',
        deposit:         c.deposit           || parseFloat(p.deposit) || 0,
      });
      await contractSnap.ref.update({ assinafyError: null, updatedAt: FieldValue.serverTimestamp() });
      console.log('[cron-retry-assinafy] sucesso:', contractId);
      retried++;
    } catch (e) {
      console.error('[cron-retry-assinafy] falhou novamente:', contractId, e.message);
      failed++;
    }
    await sleep(2000);
  }
  return { retried, failed };
}

  if (req.method === 'GET') {
    const { view, contractId, step: getStep } = req.query || {};
    if (getStep === 'wa-keepalive') {
      try {
        initFirebase();
        const db = getFirestore();
        const result = await handleWaKeepalive(db);
        return res.status(200).json(result);
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }
    if (view === 'contract' && contractId) {
      try {
        initFirebase();
        const db = getFirestore();
        const snap = await db.collection('contracts').doc(contractId).get();
        if (!snap.exists) return res.status(404).send('Contrato não encontrado');
        const c = snap.data();
        const ownerSnap = await db.collection('owners').doc(c.ownerId).get();
        const owner = ownerSnap.data() || {};
        const html = generateContractHtml({
          ownerName: owner.name, ownerEmail: owner.email, ownerCpf: owner.cpf || owner.cnpj,
          tenantName: c.tenantName, tenantEmail: c.tenantEmail, tenantCpf: c.tenantCpf, tenantPhone: c.tenantPhone,
          propertyCode: c.propertyCode, propertyAddress: c.propertyAddress,
          baseRent: c.baseRent, dueDay: c.dueDay, startDate: c.startDate, endDate: c.endDate, deposit: c.deposit
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(html);
      } catch (e) { return res.status(500).send(e.message); }
    }
    return res.status(200).json({ ok: true, endpoint: 'locarpay-broker' });
  }

  // Cron: retentar contratos que falharam no Assinafy
  if (req.method === 'POST' && req.body?.step === 'cron-retry-assinafy') {
    try {
      initFirebase();
      const db = getFirestore();
      const result = await handleCronRetryAssinafy(db);
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Webhook do Evolution API (POST /api/locarpay-broker?step=evolution-webhook)
  if (req.query?.step === 'evolution-webhook') {
    try {
      initFirebase();
      const db = getFirestore();
      const event = req.body?.event || req.body?.type;
      if (event === 'messages.update' || event === 'message.update') {
        const updates = Array.isArray(req.body?.data) ? req.body.data : [req.body?.data].filter(Boolean);
        const batch = db.batch();
        let updated = 0;
        for (const upd of updates) {
          const status = upd?.status || upd?.update?.status;
          const remoteJid = upd?.key?.remoteJid || upd?.remoteJid || '';
          const fromMe = upd?.key?.fromMe ?? upd?.fromMe ?? false;
          if (!fromMe) continue;
          if (status !== 'READ' && status !== 'read' && status !== 4) continue;
          const phone = remoteJid.replace(/@.*/, '').replace(/\D/g, '');
          if (!phone) continue;
          console.log(`[evo-webhook] READ phone=${phone}`);
          const chamadosSnap = await db.collectionGroup('messages')
            .where('readByTenant', '==', false)
            .where('fromMe', '==', true)
            .get();
          for (const msgDoc of chamadosSnap.docs) {
            const msgPhone = (msgDoc.data().tenantPhone || '').replace(/\D/g, '');
            if (msgPhone && msgPhone.endsWith(phone.slice(-8))) {
              batch.update(msgDoc.ref, { readByTenant: true, readAt: new Date().toISOString() });
              updated++;
            }
          }
        }
        if (updated > 0) await batch.commit();
        console.log(`[evo-webhook] ${updated} msgs lidas`);
      }
    } catch (e) {
      console.error('[evo-webhook]', e.message);
    }
    return res.status(200).json({ ok: true });
  }

  try {
    initFirebase();
    const db   = getFirestore();
    const sa   = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT || '{}');
    req._storageBucket = 'transgu-web-6d50f.firebasestorage.app';
    const { step } = req.body || {};
    let result;
    if      (step === 'register-broker')   result = await handleRegisterBroker(db, req.body);
    else if (step === 'update-broker')     result = await handleUpdateBroker(db, req.body);
    else if (step === 'delete-broker')     result = await handleDeleteBroker(db, req.body);
    else if (step === 'submit-lead')       result = await handleSubmitLead(db, req.body);
    else if (step === 'approve-lead')         result = await handleApproveLead(db, req.body);
    else if (step === 'generate-contract')    result = await handleGenerateContract(db, req.body);
    else if (step === 'deliver-keys')         result = await handleDeliverKeys(db, req.body);
    else if (step === 'check-contract-status') result = await handleCheckContractStatus(db, req.body);
    else if (step === 'cron-retry-assinafy')   result = await handleCronRetryAssinafy(db);
    else if (step === 'reject-lead')       result = await handleRejectLead(db, req.body);
    else if (step === 'remove-lead')       result = await handleRemoveLead(db, req.body);
    else if (step === 'get-upload-url')      result = await handleGetUploadUrl(req.body, req._storageBucket);
    else if (step === 'get-chat-upload-url')    result = await handleGetChatUploadUrl(req.body, req._storageBucket);
    else if (step === 'confirm-chat-upload')    result = await handleConfirmChatUpload(req.body, req._storageBucket);
    else if (step === 'upload-doc')        result = await handleUploadDoc(db, req.body);
    else if (step === 'get-signed-url')    result = await handleGetSignedReadUrl(req.body, req._storageBucket);
    else if (step === 'whatsapp-qr') {
      result = await handleWhatsappQr(db, req.body);
    }
    else if (step === 'setup-webhook') {
      const rawId = req.body.ownerId;
      const ownerId = (rawId && rawId !== 'undefined') ? rawId.trim() : null;
      let ownerData = null;
      if (ownerId) {
        const snap = await db.collection('owners').doc(ownerId).get();
        ownerData = snap.exists ? snap.data() : null;
      }
      const { baseUrl, apiKey, instance } = getEvoConfig(ownerData, ownerId);
      const evoFetch = makeEvoFetch(baseUrl, apiKey);
      const webhookUrl = 'https://www.ilocarpay.com.br/api/locarpay-broker?step=evolution-webhook';
      const body = JSON.stringify({ webhook: { enabled: true, url: webhookUrl, webhook_by_events: true, events: ['MESSAGES_UPDATE', 'MESSAGES_UPSERT'] } });
      const r = await evoFetch(`webhook/set/${instance}`, { method: 'POST', body });
      const text = await r.text();
      result = { ok: true, instance, status: r.status, body: text.slice(0, 300) };
    }
    else if (step === 'whatsapp-debug') {
      // Diagnóstico completo: cria instância e tenta pegar QR
      const rawId = req.body.ownerId;
      const ownerId = (rawId && rawId !== 'undefined') ? rawId.trim() : null;
      let ownerData = null;
      if (ownerId) {
        const snap = await db.collection('owners').doc(ownerId).get();
        ownerData = snap.exists ? snap.data() : null;
      }
      const { baseUrl, apiKey, instance } = getEvoConfig(ownerData, ownerId);
      const evoFetch = makeEvoFetch(baseUrl, apiKey);
      // 1. Estado atual
      const stateRes = await evoFetch(`instance/connectionState/${instance}`);
      const stateText = await stateRes.text();
      // 2. Criar instância
      const createRes = await evoFetch(`instance/create`, {
        method: 'POST',
        body: JSON.stringify({ instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
      });
      const createText = await createRes.text();
      // 3. Aguardar e pegar QR
      await new Promise(r => setTimeout(r, 3000));
      const connectRes = await evoFetch(`instance/connect/${instance}`);
      const connectText = await connectRes.text();
      result = {
        ok: true, instance, baseUrl: baseUrl.slice(0,30)+'...',
        stateStatus: stateRes.status, stateBody: stateText.slice(0,300),
        createStatus: createRes.status, createBody: createText.slice(0,300),
        connectStatus: connectRes.status, connectBody: connectText.slice(0,300),
      };
    }
    else if (step === 'whatsapp-disconnect') {
      result = await handleWhatsappDisconnect(db, req.body);
    }
    else if (step === 'wa-keepalive') {
      result = await handleWaKeepalive(db);
    }
    else if (step === 'send-whatsapp-test') {
      const { phone, message } = req.body;
      if (!phone) throw Object.assign(new Error('phone obrigatório'), { status: 400 });
      await sendWhatsApp(phone, message || 'Teste iLocarPay\n\nhttps://www.ilocarpay.com.br');
      result = { ok: true };
    }
    else if (step === 'test-email') {
      const { to } = req.body;
      if (!to) throw Object.assign(new Error('to obrigatório'), { status: 400 });
      await sendEmail(to, '✅ Teste SMTP — iLocarPay', '<p>E-mail de teste enviado com sucesso!</p>');
      result = { ok: true, to, smtp: 'noreply@dlftech.com.br' };
    }
    else if (step === 'test-assinafy') {
      const { documentId, ownerEmail, tenantEmail } = req.body;
      const configSnap = await db.collection('config').doc('assinafy').get();
      const apiKey = configSnap.data()?.apiKey;
      const accountId = await getAssinafyAccount(apiKey);
      // Cria signatários de teste (get-or-create)
      let s1Id, s2Id, assignRes;
      try { s1Id = await getOrCreateSigner(apiKey, accountId, 'Proprietário Teste', ownerEmail  || 'denisfelicio20@gmail.com'); } catch(e) { s1Id = null; }
      try { s2Id = await getOrCreateSigner(apiKey, accountId, 'Inquilino Teste',    tenantEmail || 'denisfelicio2@gmail.com');  } catch(e) { s2Id = null; }
      if (s1Id && s2Id) {
        try {
          assignRes = await assinafyReq('POST', `documents/${documentId}/assignments`, {
            method: 'virtual',
            message: 'Por favor, assine o contrato de locação.',
            signers: [
              { id: s1Id, step: 1, action: 'sign', verification_method: 'Email', notification_methods: ['Email'] },
              { id: s2Id, step: 2, action: 'sign', verification_method: 'Email', notification_methods: ['Email'] }
            ]
          }, apiKey);
        } catch(e) { assignRes = { error: e.message }; }
      }
      result = { accountId, s1Id, s2Id, assign: assignRes?.data || assignRes };
    }
    else if (step === 'save-assinafy-key') {
      const { apiKey, callerEmail } = req.body;
      if (!apiKey) throw Object.assign(new Error('apiKey obrigatório'), { status: 400 });
      await db.collection('config').doc('assinafy').set({ apiKey }, { merge: true });
      result = { ok: true };
    }
    else if (step === 'retry-assinafy') {
      // Reenviar contrato ao Assinafy quando a primeira tentativa falhou
      const { contractId } = req.body;
      if (!contractId) throw Object.assign(new Error('contractId obrigatório'), { status: 400 });
      const contractSnap = await db.collection('contracts').doc(contractId).get();
      if (!contractSnap.exists) throw Object.assign(new Error('Contrato não encontrado'), { status: 404 });
      const c = contractSnap.data();
      if (c.assinafyDocumentId) throw Object.assign(new Error('Contrato já enviado ao Assinafy: ' + c.assinafyDocumentId), { status: 409 });
      // Busca lead para reconstruir os dados
      const leadsSnap = await db.collection('leads').where('contractId', '==', contractId).limit(1).get();
      if (leadsSnap.empty) throw Object.assign(new Error('Lead não encontrado para este contrato'), { status: 404 });
      const lead = leadsSnap.docs[0].data();
      const t = lead.tenant || {};
      const p = lead.property || {};
      const landlord = lead.landlord || {};
      const propAddr = buildAddr(p);
      const assinafyResult = await createAssinafyContract(db, contractId, {
        contractId,
        ownerName:       landlord.name || c.landlordName || '',
        ownerEmail:      landlord.email || c.landlordEmail || '',
        ownerCpf:        landlord.cpf || c.landlordCpf || '',
        tenantName:      t.name || c.tenantName || '',
        tenantEmail:     t.email || c.tenantEmail || '',
        tenantCpf:       t.cpf || '',
        tenantPhone:     t.phone || '',
        propertyCode:    lead.propertyCode || p.code || '',
        propertyAddress: propAddr || c.propertyAddress || '',
        baseRent:        c.baseRent || parseFloat(p.rentValue) || 0,
        dueDay:          c.dueDay || p.dueDay || 10,
        startDate:       c.startDate || p.startDate || '',
        endDate:         c.endDate || p.endDate || '',
        deposit:         c.deposit || parseFloat(p.deposit) || 0,
      });
      // Limpa o erro anterior
      await contractSnap.ref.update({ assinafyError: null, updatedAt: FieldValue.serverTimestamp() });
      result = { ok: true, assinafyDocumentId: assinafyResult?.documentId || null };
    }
    else if (step === 'mark-both-signed') {
      const { leadId } = req.body;
      if (!leadId) throw Object.assign(new Error('leadId obrigatório'), { status: 400 });
      await db.collection('leads').doc(leadId).update({ bothSigned: true, updatedAt: FieldValue.serverTimestamp() });
      result = { ok: true };
    }
    else throw Object.assign(new Error('step inválido'), { status: 400 });
    res.status(200).json(result);
  } catch (e) {
    console.error('[locarpay-broker]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
}
