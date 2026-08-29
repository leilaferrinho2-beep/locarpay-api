// Reenvia o contrato Assinafy para o lead aprovado mais recente
const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const CONTRACT_ID = 'DvNjukoPCk30OrQT2dqy'; // contrato do lead nP9EzyheJ2UGpXrGqrs0

(async () => {
  const contractRef = db.collection('contracts').doc(CONTRACT_ID);
  const c = (await contractRef.get()).data();
  if (!c) { console.error('Contrato não encontrado'); process.exit(1); }

  console.log('Contrato:', CONTRACT_ID);
  console.log('assinafyStatus atual:', c.assinafyStatus);
  console.log('landlordEmail:', c.landlordEmail);
  console.log('tenantEmail:', c.tenantEmail);
  console.log('assinafyDocumentId:', c.assinafyDocumentId || 'AUSENTE');

  // Chama a rota generate-contract via HTTP para reenviar
  const resp = await fetch('https://www.ilocarpay.com.br/api/locarpay-broker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: 'generate-contract', contractId: CONTRACT_ID })
  });
  const data = await resp.json();
  console.log('\nResposta generate-contract:', JSON.stringify(data, null, 2));
  process.exit(0);
})();
