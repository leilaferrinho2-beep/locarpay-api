const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const BASE = 'https://api.assinafy.com.br/v1';
const CONTRACT_ID = 'DvNjukoPCk30OrQT2dqy';

(async () => {
  const snap = await db.collection('config').doc('assinafy').get();
  const apiKey = snap.data()?.apiKey;

  const c = (await db.collection('contracts').doc(CONTRACT_ID).get()).data();
  const docId = c.assinafyDocumentId;
  console.log('Documento Assinafy:', docId);
  console.log('contractStatus atual:', c.contractStatus);

  const r = await fetch(`${BASE}/documents/${docId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
  });
  const data = (await r.json())?.data;
  console.log('\nStatus Assinafy:', data?.status);

  const signers = data?.assignment?.signers || [];
  for (const s of signers) {
    console.log(`  Step ${s.step} | ${s.full_name} <${s.email}> | completed: ${s.completed}`);
  }

  // Sincroniza status no Firestore
  const allSigned = signers.length > 0 && signers.every(s => s.completed);
  const s1Done = signers.find(s => s.step === 1)?.completed;
  const s2Done = signers.find(s => s.step === 2)?.completed;

  let newStatus = c.contractStatus;
  let assinafyStatus = c.assinafyStatus;

  if (allSigned) {
    newStatus = 'ASSINADO';
    assinafyStatus = 'completed';
  } else if (s1Done && !s2Done) {
    newStatus = 'AGUARDANDO_INQUILINO';
    assinafyStatus = 'pending';
  }

  if (newStatus !== c.contractStatus || assinafyStatus !== c.assinafyStatus) {
    await db.collection('contracts').doc(CONTRACT_ID).update({
      contractStatus: newStatus,
      assinafyStatus,
      updatedAt: FieldValue.serverTimestamp()
    });
    console.log(`\n✓ Contrato atualizado: ${c.contractStatus} → ${newStatus}`);
  } else {
    console.log('\nStatus já está correto:', newStatus);
  }

  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
