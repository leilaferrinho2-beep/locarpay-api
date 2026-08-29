const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const BASE = 'https://api.assinafy.com.br/v1';
const CONTRACT_ID = 'DvNjukoPCk30OrQT2dqy';
const DOCUMENT_ID = '10431b6d7e9859c058e0504b793f';
const ACCOUNT_ID  = '103f4c6d650f4c131c84c82ab7c9';

// Signers reais (proprietário e inquilino)
const LANDLORD_EMAIL = 'denisfelicio20@gmail.com';
const TENANT_EMAIL   = 'leilaferrinho2@gmail.com';
const S1_ID = '103f6d4dc543fe1fbee504829c84'; // proprietário
const S2_ID = '10431afd0a4fab11b1830ee1d0c2'; // inquilino

(async () => {
  const snap = await db.collection('config').doc('assinafy').get();
  const apiKey = snap.data()?.apiKey;

  // Busca documento com seus assignments
  const r = await fetch(`${BASE}/documents/${DOCUMENT_ID}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
  });
  const docData = await r.json();
  console.log('Documento status:', docData?.data?.status || docData?.status);

  // Busca assignments do documento
  const r2 = await fetch(`${BASE}/accounts/${ACCOUNT_ID}/documents/${DOCUMENT_ID}/assignments`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
  });
  const assignData = await r2.json();
  console.log('Assignments:', JSON.stringify(assignData, null, 2));
  process.exit(0);
})();
