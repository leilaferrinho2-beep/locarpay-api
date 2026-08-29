// O doc Assinafy 10431b6d7e9859c058e0504b793f já foi criado com o PDF.
// Falhou só no assignment (verification_method: 'Facial').
// Agora criamos o assignment com 'Email' direto nesse documento.
const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const BASE = 'https://api.assinafy.com.br/v1';
const CONTRACT_ID  = 'DvNjukoPCk30OrQT2dqy';
const DOCUMENT_ID  = '10431b6d7e9859c058e0504b793f'; // criado pelo último generate-contract
const ACCOUNT_ID   = '103f4c6d650f4c131c84c82ab7c9';

async function req(method, path, body, apiKey) {
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

async function getOrCreateSigner(apiKey, name, email) {
  try {
    const res = await req('POST', `accounts/${ACCOUNT_ID}/signers`, { full_name: name, email }, apiKey);
    return res?.data?.id || res?.id;
  } catch {
    const search = await req('GET', `accounts/${ACCOUNT_ID}/signers?email=${encodeURIComponent(email)}`, null, apiKey);
    const found = (search?.data || []).find(s => s.email === email);
    if (found) return found.id;
    throw new Error('Signer não encontrado: ' + email);
  }
}

(async () => {
  const snap = await db.collection('config').doc('assinafy').get();
  const apiKey = snap.data()?.apiKey;

  const c = (await db.collection('contracts').doc(CONTRACT_ID).get()).data();
  console.log(`Criando assignment no doc ${DOCUMENT_ID}`);
  console.log(`Proprietário: ${c.landlordName} <${c.landlordEmail}>`);
  console.log(`Inquilino:    ${c.tenantName} <${c.tenantEmail}>`);

  const s1Id = await getOrCreateSigner(apiKey, c.landlordName, c.landlordEmail);
  const s2Id = await getOrCreateSigner(apiKey, c.tenantName, c.tenantEmail);
  console.log('Signer 1 (proprietário):', s1Id);
  console.log('Signer 2 (inquilino):', s2Id);

  const assignRes = await req('POST', `documents/${DOCUMENT_ID}/assignments`, {
    method: 'virtual',
    message: `Por favor, assine o contrato de locação do imóvel ${c.propertyAddress || ''}.`.trim(),
    signers: [
      { id: s1Id, step: 1, action: 'sign', verification_method: 'Email', notification_methods: ['Email'] },
      { id: s2Id, step: 2, action: 'sign', verification_method: 'Email', notification_methods: ['Email'] }
    ]
  }, apiKey);

  const assignmentId = assignRes?.data?.id || assignRes?.id;
  const signingUrls  = assignRes?.data?.signing_urls || assignRes?.signing_urls || [];
  const landlordUrl  = signingUrls.find(u => u.signer_id === s1Id)?.url || null;
  const tenantUrl    = signingUrls.find(u => u.signer_id === s2Id)?.url || null;

  console.log('\nAssignment criado:', assignmentId);

  await db.collection('contracts').doc(CONTRACT_ID).update({
    assinafyDocumentId:   DOCUMENT_ID,
    assinafyAssignmentId: assignmentId,
    assinafySignerId1:    s1Id,
    assinafySignerId2:    s2Id,
    assinafyStatus:       'pending',
    assinafyError:        FieldValue.delete(),
    landlordSignUrl:      landlordUrl,
    tenantSignUrl:        tenantUrl,
    contractStatus:       'AGUARDANDO_PROPRIETARIO',
    updatedAt:            FieldValue.serverTimestamp()
  });

  console.log('✓ Contrato atualizado no Firestore');
  console.log('landlordSignUrl:', landlordUrl);
  console.log('tenantSignUrl:', tenantUrl);
  console.log(`\nE-mail Assinafy enviado para ${c.landlordEmail} (step 1)`);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
