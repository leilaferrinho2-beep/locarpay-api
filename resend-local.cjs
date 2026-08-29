// Reenvia o contrato DvNjukoPCk30OrQT2dqy diretamente via Assinafy (sem Vercel)
const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const BASE = 'https://api.assinafy.com.br/v1';
const CONTRACT_ID = 'DvNjukoPCk30OrQT2dqy';

async function assinafyReq(method, path, body, apiKey) {
  const r = await fetch(`${BASE}/${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  const data = JSON.parse(text);
  if (r.status >= 400) throw new Error(`Assinafy ${method} ${path} ${r.status}: ${JSON.stringify(data?.message || data)}`);
  return data;
}

async function getOrCreateSigner(apiKey, accountId, name, email) {
  try {
    const res = await assinafyReq('POST', `accounts/${accountId}/signers`, { full_name: name, email }, apiKey);
    return res?.data?.id || res?.id;
  } catch (e) {
    const search = await assinafyReq('GET', `accounts/${accountId}/signers?email=${encodeURIComponent(email)}`, null, apiKey);
    const found = (search?.data || []).find(s => s.email === email);
    if (found) return found.id;
    throw e;
  }
}

(async () => {
  const snap = await db.collection('config').doc('assinafy').get();
  const apiKey = snap.data()?.apiKey;
  if (!apiKey) throw new Error('Chave Assinafy não configurada');

  const contractRef = db.collection('contracts').doc(CONTRACT_ID);
  const c = (await contractRef.get()).data();
  console.log('Contrato:', CONTRACT_ID);
  console.log('landlordEmail:', c.landlordEmail, '/', c.landlordName);
  console.log('tenantEmail:', c.tenantEmail, '/', c.tenantName);

  // Anula documento Assinafy anterior se existir
  if (c.assinafyDocumentId) {
    try { await assinafyReq('POST', `documents/${c.assinafyDocumentId}/cancel`, {}, apiKey); console.log('Doc anterior anulado'); } catch {}
  }

  // 1. Upload PDF
  const pdfSnap = c.pdfUrl ? null : null;
  // Usa o PDF já gerado (pdfUrl no storage) — cria documento Assinafy com URL
  const accs = await assinafyReq('GET', 'accounts', null, apiKey);
  const accountId = accs?.data?.[0]?.id;
  console.log('Account ID:', accountId);

  // Cria documento no Assinafy
  const docName = `Contrato ${c.propertyAddress || CONTRACT_ID}`;
  let documentId;
  if (c.pdfUrl) {
    // Baixa PDF e faz upload
    const pdfResp = await fetch(c.pdfUrl);
    const pdfBuf = await pdfResp.arrayBuffer();
    const FormData = (await import('formdata-node')).FormData;
    const { Blob } = await import('buffer');
    const fd = new FormData();
    fd.set('name', docName);
    fd.set('file', new Blob([pdfBuf], { type: 'application/pdf' }), 'contrato.pdf');
    const r = await fetch(`${BASE}/accounts/${accountId}/documents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      body: fd
    });
    const docData = await r.json();
    if (r.status >= 400) throw new Error(`Upload PDF: ${JSON.stringify(docData)}`);
    documentId = docData?.data?.id || docData?.id;
  } else {
    throw new Error('pdfUrl ausente no contrato — não é possível criar documento Assinafy sem o PDF');
  }
  console.log('Documento Assinafy criado:', documentId);

  // 2. Cria signers
  const s1Id = await getOrCreateSigner(apiKey, accountId, c.landlordName || 'Proprietário', c.landlordEmail);
  const s2Id = await getOrCreateSigner(apiKey, accountId, c.tenantName || 'Inquilino', c.tenantEmail);
  console.log('Signer proprietário:', s1Id);
  console.log('Signer inquilino:', s2Id);

  // 3. Cria assignment
  const assignRes = await assinafyReq('POST', `documents/${documentId}/assignments`, {
    method: 'virtual',
    message: `Por favor, assine o contrato de locação do imóvel ${c.propertyAddress || ''}.`.trim(),
    signers: [
      { id: s1Id, step: 1, action: 'sign', verification_method: 'Email', notification_methods: ['Email'] },
      { id: s2Id, step: 2, action: 'sign', verification_method: 'Email', notification_methods: ['Email'] }
    ]
  }, apiKey);
  const assignmentId = assignRes?.data?.id || assignRes?.id;
  console.log('Assignment criado:', assignmentId);

  const signingUrls = assignRes?.data?.signing_urls || assignRes?.signing_urls || [];
  const landlordUrl = signingUrls.find(u => u.signer_id === s1Id)?.url || null;
  const tenantUrl   = signingUrls.find(u => u.signer_id === s2Id)?.url || null;

  // 4. Atualiza Firestore
  await contractRef.update({
    assinafyDocumentId:  documentId,
    assinafyAssignmentId: assignmentId,
    assinafySignerId1:   s1Id,
    assinafySignerId2:   s2Id,
    assinafyStatus:      'pending',
    assinafyError:       FieldValue.delete(),
    landlordSignUrl:     landlordUrl,
    tenantSignUrl:       tenantUrl,
    contractStatus:      'AGUARDANDO_PROPRIETARIO',
    updatedAt:           FieldValue.serverTimestamp()
  });

  console.log('\n✓ Contrato reenviado com sucesso!');
  console.log('landlordSignUrl:', landlordUrl);
  console.log('tenantSignUrl:', tenantUrl);
  console.log('E-mail Assinafy enviado para:', c.landlordEmail);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
