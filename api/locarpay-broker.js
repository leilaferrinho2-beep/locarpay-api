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
import PDFDocument                        from 'pdfkit';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

const ASSINAFY_BASE = 'https://api.assinafy.com.br/v1';
const APP_BASE_URL  = process.env.APP_BASE_URL || 'https://ilocarpay.com.br';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assinafyReq(method, path, body, apiKey) {
  const isFormData = body instanceof FormData;
  const r = await fetch(`${ASSINAFY_BASE}/${path}`, {
    method,
    headers: {
      'X-Api-Key': apiKey,
      'Accept': 'application/json',
      ...(!isFormData ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: isFormData ? body : JSON.stringify(body) } : {})
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Assinafy ${method} ${path} ${r.status}: ${text}`);
  return data;
}

function generateContractPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = v => (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const fmtDate = d => d ? String(d) : '—';

    doc.fontSize(16).font('Helvetica-Bold')
       .text('CONTRATO DE LOCAÇÃO RESIDENCIAL', { align: 'center' });
    doc.fontSize(10).font('Helvetica')
       .text(`Emitido por iLocarPay — ${new Date().toLocaleDateString('pt-BR')}`, { align: 'center' });
    doc.moveDown(1.5);

    const section = (title) => {
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').text(title);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);
    };

    const field = (label, value) => {
      doc.fontSize(10).font('Helvetica-Bold').text(`${label}: `, { continued: true })
         .font('Helvetica').text(value || '—');
    };

    section('1. DAS PARTES');
    field('Locador / Proprietário', data.ownerName);
    field('CPF/CNPJ do Locador', data.ownerCpf);
    field('E-mail do Locador', data.ownerEmail);
    doc.moveDown(0.3);
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

    section('4. DAS OBRIGAÇÕES DO LOCATÁRIO');
    doc.fontSize(10).font('Helvetica')
       .text('O locatário se obriga a pagar pontualmente o aluguel na data convencionada, conservar o imóvel em bom estado, não efetuar obras ou modificações sem anuência prévia do locador, e restituir o imóvel no estado em que o recebeu ao término do contrato.', { align: 'justify' });

    section('5. DAS OBRIGAÇÕES DO LOCADOR');
    doc.fontSize(10).font('Helvetica')
       .text('O locador se obriga a entregar o imóvel em condições de uso, manter a posse mansa e pacífica do imóvel durante a locação, e responder pelos vícios ou defeitos anteriores à locação.', { align: 'justify' });

    section('6. DA RESCISÃO');
    doc.fontSize(10).font('Helvetica')
       .text('O contrato pode ser rescindido por qualquer das partes mediante notificação prévia de 30 dias. A rescisão sem justa causa pelo locatário antes do prazo implica multa proporcional ao período restante.', { align: 'justify' });

    section('7. DO FORO');
    doc.fontSize(10).font('Helvetica')
       .text('As partes elegem o foro da comarca do imóvel locado para dirimir quaisquer controvérsias oriundas deste contrato.', { align: 'justify' });

    doc.moveDown(3);
    const y = doc.y;
    doc.fontSize(10).font('Helvetica')
       .text('_________________________________', 50, y)
       .text(data.ownerName || 'Locador / Proprietário', 50, doc.y, { width: 220 })
       .text(data.ownerEmail || '', 50, doc.y, { width: 220 });
    doc.fontSize(10).font('Helvetica')
       .text('_________________________________', 315, y)
       .text(data.tenantName || 'Locatário (Inquilino)', 315, doc.y, { width: 220 })
       .text(data.tenantEmail || '', 315, doc.y, { width: 220 });

    doc.end();
  });
}

async function getAssinafyAccount(apiKey) {
  const res = await assinafyReq('GET', 'accounts', null, apiKey);
  const accountId = res?.data?.[0]?.id;
  if (!accountId) throw new Error('Conta Assinafy não encontrada');
  return accountId;
}

async function sendEmail(to, subject, html, attachments) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
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

async function sendWhatsApp(phone, message) {
  const baseUrl  = process.env.EVOLUTION_API_URL;
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!baseUrl || !apiKey || !instance || !phone) return;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return;
  const number = digits.startsWith('55') ? digits : `55${digits}`;
  const headers = { 'Content-Type': 'application/json', 'apikey': apiKey };
  try {
    await fetch(`${baseUrl}/message/sendMedia/${instance}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number,
        mediatype: 'image',
        mimetype: 'image/webp',
        media: 'https://www.ilocarpay.com.br/logo.webp',
        caption: message
      })
    });
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
  const { ownerId, name, email, phone } = body;
  if (!ownerId || !email) throw Object.assign(new Error('ownerId e email obrigatórios'), { status: 400 });

  const ownerSnap = await db.collection('owners').doc(ownerId).get();
  if (!ownerSnap.exists) throw Object.assign(new Error('Imobiliária não encontrada'), { status: 404 });

  const id = email.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + ownerId.slice(0, 6);
  await db.collection('brokers').doc(id).set({
    ownerId, name: name || email.split('@')[0],
    email: email.toLowerCase().trim(), phone: phone || '',
    active: true, createdAt: FieldValue.serverTimestamp()
  }, { merge: true });

  // Adiciona ao users também para login OTP
  const userRef = db.collection('users').doc(id);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      ownerId, name: name || email.split('@')[0],
      email: email.toLowerCase().trim(), phone: phone || '',
      role: 'broker', active: true, createdAt: FieldValue.serverTimestamp()
    });
  }

  return { ok: true, brokerId: id };
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
  if (commissionPct !== undefined) updates.commissionPct = parseFloat(commissionPct) || 0;
  if (commission    !== undefined) updates.commission    = parseFloat(commission) || 0;
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
  const { leadId, contractData, landlordOverride } = body;
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
  const propAddr = cd.propertyAddress
    || [lp.street, lp.number, lp.complement, lp.neighborhood, lp.city, lp.state].filter(Boolean).join(', ')
    || lead.propertyDescription || '';

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
    baseRent:            cd.baseRent  || parseFloat(lp.rentValue)  || 0,
    dueDay:              cd.dueDay    || lp.dueDay    || 10,
    startDate:           cd.startDate || lp.startDate || '',
    endDate:             cd.endDate   || lp.endDate   || '',
    deposit:             cd.deposit   || parseFloat(lp.deposit)    || 0,
    active:              false, // ativa só após entregar as chaves
    assinafyStatus:      'pending',
    leadId,
    createdAt:           FieldValue.serverTimestamp(),
    updatedAt:           FieldValue.serverTimestamp()
  });

  // Se override fornecido, salva no lead para uso futuro
  if (landlordOverride?.name) {
    await leadRef.update({ landlord: landlordOverride });
  }

  // Gera contrato no Assinafy
  let assinafyResult = null;
  try {
    assinafyResult = await createAssinafyContract(db, contractId, {
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
    });
  } catch (e) {
    console.error('[approve-lead] Assinafy error:', e.message);
  }

  // Envia PDF do contrato por e-mail ao proprietário do imóvel (sempre, independente da Assinafy)
  if (landlordEmail) {
    try {
      const pdfData = await generateContractPdf({
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
      });
      await sendContractEmail({ landlordName, landlordEmail, tenantName: lead.tenant.name, tenantEmail, propAddr, pdfData });
    } catch (e) { console.warn('[approve-lead] contract email error:', e.message); }
  }

  // Atualiza lead
  await leadRef.update({
    status:      'approved',
    tenantId,
    contractId,
    approvedAt:  FieldValue.serverTimestamp(),
    updatedAt:   FieldValue.serverTimestamp()
  });

  // Envia e-mail de boas-vindas ao inquilino com link do app
  try {
    const prop = lead.property || {};
    const propAddr = [prop.street, prop.number, prop.complement, prop.neighborhood, prop.city, prop.state]
      .filter(Boolean).join(', ') || lead.propertyDescription || '';
    await sendEmail(tenantEmail, '🎉 Sua locação foi aprovada — iLocarPay', `
      <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
        <div style="background:#1a1a1a;padding:32px;text-align:center">
          <h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1>
          <p style="color:#ccc;margin:8px 0 0">Gestão inteligente de aluguéis</p>
        </div>
        <div style="padding:32px">
          <p style="font-size:18px;font-weight:bold;color:#1a1a1a">Parabéns, ${lead.tenant.name || 'inquilino'}! 🎉</p>
          <p style="color:#444"><strong>${owner.name || 'Sua imobiliária'}</strong> aprovou a sua locação.</p>
          ${propAddr ? `<div style="background:#f0f7f0;border-left:4px solid #4CAF50;padding:12px 16px;border-radius:4px;margin:16px 0">
            <strong>Imóvel:</strong> ${propAddr}
          </div>` : ''}
          <p style="color:#444">Você receberá o contrato por e-mail para assinar digitalmente. Acompanhe tudo pelo aplicativo:</p>
          <div style="text-align:center;margin:28px 0">
            <a href="https://www.ilocarpay.com.br/download/locarpay-v135.apk"
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
  } catch (e) { console.warn('[approve-lead] email error:', e.message); }

  // WhatsApp para o proprietário do imóvel
  if (landlordPhone) {
    const prop = lead.property || {};
    const addr = [prop.street, prop.number, prop.city].filter(Boolean).join(', ') || lead.propertyDescription || 'imóvel';
    await sendWhatsApp(landlordPhone,
      `Olá, ${landlordName}! 🏠\n\nA locação do imóvel *${addr}* foi aprovada pela imobiliária.\n\nVocê receberá um e-mail da Assinafy para assinar o contrato digitalmente. Por favor, verifique sua caixa de entrada (${landlordEmail}).\n\n— iLocarPay`
    );
  }

  // WhatsApp para o inquilino
  if (lead.tenant.phone) {
    const prop = lead.property || {};
    const addr = [prop.street, prop.number, prop.city].filter(Boolean).join(', ') || lead.propertyDescription || 'imóvel';
    await sendWhatsApp(lead.tenant.phone,
      `Parabéns, ${lead.tenant.name || 'inquilino'}! 🎉\n\nSua locação do imóvel *${addr}* foi aprovada!\n\nO contrato será assinado primeiro pelo proprietário. Assim que ele assinar, você receberá o contrato no seu e-mail (${tenantEmail}) para assinar digitalmente.\n\nBaixe o app iLocarPay para acompanhar tudo:\nhttps://www.ilocarpay.com.br\n\n— iLocarPay`
    );
  }

  // Notifica corretor
  if (lead.brokerEmail) {
    try {
      await sendEmail(lead.brokerEmail, '✅ Lead aprovado — iLocarPay', `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#4CAF50">iLocarPay</h2>
          <p>Olá, <strong>${lead.brokerName || lead.brokerEmail}</strong>!</p>
          <p>O lead <strong>${lead.tenant.name}</strong> foi <strong style="color:#4CAF50">aprovado</strong>.</p>
          <p>O contrato foi enviado para assinatura digital. Após a assinatura de ambas as partes, as chaves poderão ser entregues.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px;text-align:center">Equipe iLocarPay</p>
        </div>
      `);
    } catch (e) { console.warn('[approve-lead] broker email error:', e.message); }
  }

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

  // 2. Cria signatários
  const [s1Res, s2Res] = await Promise.all([
    assinafyReq('POST', `accounts/${accountId}/signers`,
      { full_name: data.ownerName  || 'Proprietário', email: data.ownerEmail  }, apiKey),
    assinafyReq('POST', `accounts/${accountId}/signers`,
      { full_name: data.tenantName || 'Inquilino',    email: data.tenantEmail }, apiKey),
  ]);
  const s1Id = s1Res?.data?.id;
  const s2Id = s2Res?.data?.id;
  if (!s1Id || !s2Id) throw new Error('Assinafy não retornou IDs dos signatários');

  // 3. Cria assignment (sequencial: proprietário step 1, inquilino step 2)
  const assignRes = await assinafyReq('POST', `documents/${documentId}/assignments`, {
    signers: [
      { id: s1Id, step: 1, action: 'sign' },
      { id: s2Id, step: 2, action: 'sign' }
    ]
  }, apiKey);
  const assignmentId = assignRes?.data?.id;

  // 4. Tenta publicar/enviar o documento
  let sendRes = null;
  try {
    sendRes = await assinafyReq('POST', `documents/${documentId}/send`, null, apiKey);
  } catch (_) {
    try { sendRes = await assinafyReq('POST', `documents/${documentId}/publish`, null, apiKey); } catch (_) {}
  }

  // 5. Extrai URLs de assinatura — tenta da resposta do assignment, depois do send, depois busca o documento
  let signingUrls = assignRes?.data?.signing_urls || sendRes?.data?.signing_urls || [];
  if (!signingUrls.length) {
    try {
      const docDetail = await assinafyReq('GET', `documents/${documentId}`, null, apiKey);
      signingUrls = docDetail?.data?.signing_urls || docDetail?.data?.assignments?.[0]?.signing_urls || [];
    } catch (_) {}
  }
  const ownerSignUrl  = signingUrls.find(u => u.signer_id === s1Id)?.url || null;
  const tenantSignUrl = signingUrls.find(u => u.signer_id === s2Id)?.url || null;

  // 6. Envia e-mail ao proprietário — com link de assinatura se disponível, ou apenas aviso com PDF
  if (data.ownerEmail) {
    try {
      const btnSection = ownerSignUrl
        ? `<div style="text-align:center;margin:28px 0">
            <a href="${ownerSignUrl}" style="background:#4CAF50;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
              ✍️ Assinar contrato agora
            </a>
           </div>
           <p style="color:#888;font-size:13px">Após sua assinatura, o contrato será enviado ao inquilino para assinatura.</p>`
        : `<p style="color:#444">Em breve você receberá o link de assinatura digital da Assinafy no mesmo e-mail. Por favor, verifique também sua caixa de spam.</p>`;
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
    } catch (e) { console.warn('[assinafy] owner sign email error:', e.message); }
  }

  if (tenantSignUrl && data.tenantEmail) {
    try {
      await sendEmail(data.tenantEmail, '📝 Contrato aguarda sua assinatura — iLocarPay', `
        <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
          <div style="background:#1a1a1a;padding:32px;text-align:center">
            <h1 style="color:#4CAF50;margin:0;font-size:28px">iLocarPay</h1>
          </div>
          <div style="padding:32px">
            <p>Olá, <strong>${data.tenantName || 'Inquilino'}</strong>!</p>
            <p>O proprietário já assinou o contrato de locação. Agora é a sua vez!</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${tenantSignUrl}" style="background:#4CAF50;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
                ✍️ Assinar contrato agora
              </a>
            </div>
          </div>
        </div>
      `);
    } catch (e) { console.warn('[assinafy] tenant sign email error:', e.message); }
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
    result = await createAssinafyContract(db, contractId, { ...contractPdfData, tenantPhone });
  } catch (e) {
    console.error('[generate-contract] Assinafy error:', e.message);
  }

  // Envia PDF do contrato por e-mail ao proprietário (sempre, independente da Assinafy)
  if (landlordEmail) {
    try {
      const pdfData = await generateContractPdf(contractPdfData);
      const propAddr = c.propertyAddress || c.address || c.propertyCode || '';
      await sendContractEmail({ landlordName, landlordEmail, tenantName, tenantEmail: c.tenantEmail, propAddr, pdfData });
    } catch (e) { console.warn('[generate-contract] contract email error:', e.message); }
  }

  // Salva phones no contrato para o webhook usar depois
  await db.collection('contracts').doc(contractId).update({
    landlordPhone, tenantPhone,
    updatedAt: FieldValue.serverTimestamp()
  });

  // WhatsApp ao proprietário do imóvel
  const addr = c.propertyAddress || c.address || c.propertyCode || 'o imóvel';
  if (landlordPhone) {
    await sendWhatsApp(landlordPhone,
      `Olá, ${landlordName}! 🏠\n\nUm contrato de locação do imóvel *${addr}* foi gerado e enviado para o seu e-mail (${landlordEmail}) para assinatura digital.\n\nPor favor, verifique sua caixa de entrada e assine o contrato para concluir a locação.\n\n— iLocarPay`
    );
  }

  // WhatsApp ao inquilino informando que o contrato vai ao proprietário primeiro
  if (tenantPhone) {
    await sendWhatsApp(tenantPhone,
      `Olá, ${tenantName}! 🎉\n\nO contrato de locação do imóvel *${addr}* foi gerado. Ele será assinado primeiro pelo proprietário. Assim que ele assinar, você receberá o contrato no seu e-mail (${c.tenantEmail}) para assinar digitalmente.\n\n— iLocarPay`
    );
  }

  return { ok: true, ...result };
}

// ── DELIVER KEYS ──────────────────────────────────────────────────────────────

async function handleDeliverKeys(db, body) {
  const { contractId, tenantId } = body;
  if (!contractId || !tenantId) throw Object.assign(new Error('contractId e tenantId obrigatórios'), { status: 400 });

  await Promise.all([
    db.collection('contracts').doc(contractId).update({
      active:           true,
      keysDeliveredAt:  FieldValue.serverTimestamp(),
      updatedAt:        FieldValue.serverTimestamp()
    }),
    db.collection('users').doc(tenantId).update({
      active:    true,
      activatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    })
  ]);

  // Atualiza lead se existir
  try {
    const leads = await db.collection('leads').where('contractId', '==', contractId).limit(1).get();
    if (!leads.empty) await leads.docs[0].ref.update({ status: 'delivered', updatedAt: FieldValue.serverTimestamp() });
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

  // WhatsApp ao inquilino — neutro, sem expor motivo
  if (tenant.phone) {
    await sendWhatsApp(tenant.phone,
      `Olá, ${tenant.name || 'inquilino'}.\n\nInformamos que sua proposta de locação para o imóvel *${addr}* não foi aprovada neste momento.\n\nPara mais informações, entre em contato com a imobiliária responsável.\n\n— iLocarPay`
    );
  }

  // WhatsApp ao proprietário
  if (lead.landlordPhone) {
    await sendWhatsApp(lead.landlordPhone,
      `Olá! Informamos que a proposta de locação do imóvel *${addr}* não foi aprovada pela imobiliária neste momento.\n\n— iLocarPay`
    );
  }

  return { ok: true };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

async function handleGetSignedReadUrl(body, bucket) {
  const { path } = body;
  if (!path) throw Object.assign(new Error('path obrigatório'), { status: 400 });
  const storage = getStorage();
  const bucketName = bucket || 'transgu-web-6d50f.firebasestorage.app';
  const file = storage.bucket(bucketName).file(path);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 60 * 60 * 1000, // 1h
  });
  return { ok: true, url };
}

async function handleGetUploadUrl(body, bucket) {
  const { ownerId, fileName } = body;
  if (!ownerId || !fileName) throw Object.assign(new Error('ownerId e fileName obrigatórios'), { status: 400 });
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `leads/${ownerId}/${Date.now()}_${safeName}`;
  const storage = getStorage();
  const bucketName = bucket || 'locarpayapp.appspot.com';
  const file = storage.bucket(bucketName).file(path);
  const [signedUrl] = await file.getSignedUrl({
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000,
    version: 'v4',
  });
  const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media`;
  return { ok: true, uploadUrl: signedUrl, publicUrl, path };
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
    await file.makePublic();
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

  // Webhook da Assinafy — chamado quando documento é assinado por todos
  if (req.method === 'POST' && req.query?.webhook === 'assinafy') {
    try {
      initFirebase();
      const db = getFirestore();
      const event = req.body?.event || req.body?.type || '';
      const documentId = req.body?.data?.document_id || req.body?.document_id || '';
      const isCompleted = event === 'document_ready' || event === 'document.completed' || event === 'finished' || req.body?.data?.status === 'completed' || req.body?.data?.status === 'ready';
      if (isCompleted && documentId) {
        // Acha o contrato pelo assinafyDocumentId
        const contractSnap = await db.collection('contracts')
          .where('assinafyDocumentId', '==', documentId).limit(1).get();
        if (!contractSnap.empty) {
          const contractDoc = contractSnap.docs[0];
          const contractData = contractDoc.data();
          await contractDoc.ref.update({ assinafyStatus: 'completed', updatedAt: FieldValue.serverTimestamp() });
          // Atualiza lead com bothSigned=true
          if (contractData.leadId) {
            await db.collection('leads').doc(contractData.leadId).update({
              bothSigned: true,
              updatedAt: FieldValue.serverTimestamp()
            });
          } else {
            // Busca lead pelo contractId
            const leadSnap = await db.collection('leads')
              .where('contractId', '==', contractDoc.id).limit(1).get();
            if (!leadSnap.empty) {
              await leadSnap.docs[0].ref.update({ bothSigned: true, updatedAt: FieldValue.serverTimestamp() });
            }
          }
        }
      }
    } catch (e) { console.warn('[assinafy-webhook]', e.message); }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const { view, contractId } = req.query || {};
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

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db   = getFirestore();
    const sa   = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT || '{}');
    req._storageBucket = sa.project_id ? `${sa.project_id}.appspot.com` : null;
    const { step } = req.body || {};
    let result;
    if      (step === 'register-broker')   result = await handleRegisterBroker(db, req.body);
    else if (step === 'update-broker')     result = await handleUpdateBroker(db, req.body);
    else if (step === 'delete-broker')     result = await handleDeleteBroker(db, req.body);
    else if (step === 'submit-lead')       result = await handleSubmitLead(db, req.body);
    else if (step === 'approve-lead')      result = await handleApproveLead(db, req.body);
    else if (step === 'generate-contract') result = await handleGenerateContract(db, req.body);
    else if (step === 'deliver-keys')      result = await handleDeliverKeys(db, req.body);
    else if (step === 'reject-lead')       result = await handleRejectLead(db, req.body);
    else if (step === 'remove-lead')       result = await handleRemoveLead(db, req.body);
    else if (step === 'get-upload-url')    result = await handleGetUploadUrl(req.body, req._storageBucket);
    else if (step === 'upload-doc')        result = await handleUploadDoc(db, req.body);
    else if (step === 'get-signed-url')    result = await handleGetSignedReadUrl(req.body, req._storageBucket);
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
