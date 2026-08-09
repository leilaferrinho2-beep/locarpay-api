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
import nodemailer                         from 'nodemailer';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

const ASSINAFY_BASE = 'https://api.assinafy.com.br/v1';
const APP_BASE_URL  = process.env.APP_BASE_URL || 'https://ilocarpay.com.br';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assinafyReq(method, path, body, apiKey) {
  const r = await fetch(`${ASSINAFY_BASE}/${path}`, {
    method,
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Assinafy ${method} ${path} ${r.status}: ${text}`);
  return data;
}

async function getAssinafyAccount(apiKey) {
  const res = await assinafyReq('GET', 'accounts', null, apiKey);
  const accountId = res?.data?.[0]?.id;
  if (!accountId) throw new Error('Conta Assinafy não encontrada');
  return accountId;
}

async function sendEmail(to, subject, html) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email', port: 587, secure: false,
    auth: { user: 'denis@dlftech.com.br', pass: process.env.TITAN_SMTP_PASSWORD }
  });
  await transporter.sendMail({ from: 'iLocarPay <denis@dlftech.com.br>', to, subject, html });
}

async function sendWhatsApp(phone, message) {
  const baseUrl  = process.env.EVOLUTION_API_URL;
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!baseUrl || !apiKey || !instance || !phone) return;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return;
  const number = digits.startsWith('55') ? digits : `55${digits}`;
  try {
    await fetch(`${baseUrl}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number, text: message })
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
  const { brokerId, name, phone, active } = body;
  if (!brokerId) throw Object.assign(new Error('brokerId obrigatório'), { status: 400 });
  const updates = {};
  if (name  !== undefined) updates.name  = name;
  if (phone !== undefined) updates.phone = phone;
  if (active !== undefined) updates.active = active;
  if (!Object.keys(updates).length) throw Object.assign(new Error('Nenhum campo para atualizar'), { status: 400 });
  await db.collection('brokers').doc(brokerId).update(updates);
  // Espelha no users também
  await db.collection('users').doc(brokerId).update(updates).catch(() => {});
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
  const { leadId, contractData } = body;
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

  // Cria contrato
  const cd = contractData || {};
  const contractRef = db.collection('contracts').doc();
  const contractId  = contractRef.id;
  await contractRef.set({
    ownerId:             lead.ownerId,
    tenantId,
    tenantEmail,
    tenantName:          lead.tenant.name,
    tenantCpf:           lead.tenant.cpf,
    propertyCode:        lead.propertyCode || '',
    propertyDescription: lead.propertyDescription || '',
    propertyAddress:     cd.propertyAddress || lead.propertyDescription || '',
    baseRent:            cd.baseRent  || 0,
    dueDay:              cd.dueDay    || 10,
    startDate:           cd.startDate || '',
    endDate:             cd.endDate   || '',
    deposit:             cd.deposit   || 0,
    active:              false, // ativa só após entregar as chaves
    assinafyStatus:      'pending',
    leadId,
    createdAt:           FieldValue.serverTimestamp(),
    updatedAt:           FieldValue.serverTimestamp()
  });

  // Usa dados do proprietário do imóvel (landlord) ou fallback para o owner (imobiliária)
  const landlord = lead.landlord || {};
  const landlordName  = landlord.name  || owner.name  || '';
  const landlordEmail = landlord.email || owner.email || '';
  const landlordCpf   = landlord.cpf   || owner.cpf   || owner.cnpj || '';
  const landlordPhone = landlord.phone || owner.phone || '';

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
      propertyAddress: cd.propertyAddress || lead.propertyDescription || '',
      baseRent:  cd.baseRent  || 0,
      dueDay:    cd.dueDay    || 10,
      startDate: cd.startDate || '',
      endDate:   cd.endDate   || '',
      deposit:   cd.deposit   || 0
    });
  } catch (e) {
    console.error('[approve-lead] Assinafy error:', e.message);
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
      `Parabéns, ${lead.tenant.name || 'inquilino'}! 🎉\n\nSua locação do imóvel *${addr}* foi aprovada!\n\nVocê receberá um e-mail para assinar o contrato digitalmente. Verifique sua caixa de entrada (${tenantEmail}).\n\nBaixe o app iLocarPay para acompanhar tudo:\nhttps://www.ilocarpay.com.br/download/locarpay-v82.apk\n\n— iLocarPay`
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
  const contractUrl = `${APP_BASE_URL}/api/locarpay-broker?view=contract&contractId=${contractId}`;

  // Cria documento
  const docRes = await assinafyReq('POST', `accounts/${accountId}/documents`, {
    name: `Contrato de Locação — ${data.tenantName || contractId}`,
    file_url: contractUrl
  }, apiKey);
  const documentId = docRes?.data?.id || docRes?.id;
  if (!documentId) throw new Error('Assinafy não retornou documentId: ' + JSON.stringify(docRes));

  // Cria assignment com 2 signatários
  const assignRes = await assinafyReq('POST', `accounts/${accountId}/documents/${documentId}/assignments`, {
    signers: [
      { step: 1, name: data.ownerName,  email: data.ownerEmail,  action: 'sign' },
      { step: 2, name: data.tenantName, email: data.tenantEmail, action: 'sign' }
    ]
  }, apiKey);
  const assignmentId = assignRes?.data?.id || assignRes?.id;

  // Salva IDs no contrato
  await db.collection('contracts').doc(contractId).update({
    assinafyDocumentId:   documentId,
    assinafyAssignmentId: assignmentId || '',
    assinafyStatus:       'sent',
    updatedAt:            FieldValue.serverTimestamp()
  });

  // Pega link de assinatura do proprietário (step 1)
  const signers = assignRes?.data?.signers || assignRes?.signers || [];
  const ownerSigner = signers.find(s => s.step === 1) || signers[0];

  return { documentId, assignmentId, ownerSignUrl: ownerSigner?.sign_url || null };
}

async function handleGenerateContract(db, body) {
  const { contractId } = body;
  if (!contractId) throw Object.assign(new Error('contractId obrigatório'), { status: 400 });

  const contractSnap = await db.collection('contracts').doc(contractId).get();
  if (!contractSnap.exists) throw Object.assign(new Error('Contrato não encontrado'), { status: 404 });
  const c = contractSnap.data();

  const ownerSnap = await db.collection('owners').doc(c.ownerId).get();
  const owner = ownerSnap.data() || {};

  const result = await createAssinafyContract(db, contractId, {
    contractId,
    ownerName:    owner.name,
    ownerEmail:   owner.email,
    ownerCpf:     owner.cpf || owner.cnpj || '',
    tenantName:   c.tenantName,
    tenantEmail:  c.tenantEmail,
    tenantCpf:    c.tenantCpf,
    tenantPhone:  c.tenantPhone,
    propertyCode:    c.propertyCode,
    propertyAddress: c.propertyAddress,
    baseRent:  c.baseRent,
    dueDay:    c.dueDay,
    startDate: c.startDate,
    endDate:   c.endDate,
    deposit:   c.deposit || 0
  });

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

  return { ok: true };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: serve HTML do contrato para Assinafy
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
    else throw Object.assign(new Error('step inválido'), { status: 400 });
    res.status(200).json(result);
  } catch (e) {
    console.error('[locarpay-broker]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
}
