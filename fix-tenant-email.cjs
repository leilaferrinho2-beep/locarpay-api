const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const OLD_EMAIL = 'leilaferrinho2@gmail.com';
const NEW_EMAIL = 'leilamferrinho@outlook.com';
const LEAD_ID     = 'nP9EzyheJ2UGpXrGqrs0';
const CONTRACT_ID = 'DvNjukoPCk30OrQT2dqy';

(async () => {
  // Atualiza lead
  const leadRef = db.collection('leads').doc(LEAD_ID);
  const lead = (await leadRef.get()).data();
  console.log('Lead tenantEmail atual:', lead?.tenant?.email || lead?.tenantEmail);
  const leadUpdate = {};
  if (lead?.tenant?.email === OLD_EMAIL) leadUpdate['tenant.email'] = NEW_EMAIL;
  if (lead?.tenantEmail === OLD_EMAIL)   leadUpdate['tenantEmail']  = NEW_EMAIL;
  if (Object.keys(leadUpdate).length) {
    await leadRef.update({ ...leadUpdate, updatedAt: FieldValue.serverTimestamp() });
    console.log('Lead atualizado ✓');
  }

  // Atualiza contrato
  const contractRef = db.collection('contracts').doc(CONTRACT_ID);
  const c = (await contractRef.get()).data();
  console.log('Contract tenantEmail atual:', c?.tenantEmail);
  if (c?.tenantEmail === OLD_EMAIL) {
    await contractRef.update({ tenantEmail: NEW_EMAIL, updatedAt: FieldValue.serverTimestamp() });
    console.log('Contrato atualizado ✓');
  }

  // Atualiza usuário (se existir com esse email)
  const usersSnap = await db.collection('users').where('email', '==', OLD_EMAIL).get();
  for (const doc of usersSnap.docs) {
    await doc.ref.update({ email: NEW_EMAIL });
    console.log('User doc atualizado:', doc.id, '✓');
  }

  const tenantsSnap = await db.collection('tenants').where('email', '==', OLD_EMAIL).get();
  for (const doc of tenantsSnap.docs) {
    await doc.ref.update({ email: NEW_EMAIL });
    console.log('Tenant doc atualizado:', doc.id, '✓');
  }

  console.log('\nE-mail do inquilino atualizado de', OLD_EMAIL, 'para', NEW_EMAIL);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
