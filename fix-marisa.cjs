const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const EMAIL = 'marisablfelicio@gmail.com';
const OLD_ID = 'LD7zmbQFxuT6rGfSAHVcOM3LP7I2';

(async () => {
  // Busca o UID real no Firebase Auth
  const authUser = await admin.auth().getUserByEmail(EMAIL);
  const realUid = authUser.uid;
  console.log('Auth UID real:', realUid);
  console.log('Firestore ID atual:', OLD_ID);
  console.log('Migração necessária:', realUid !== OLD_ID);

  if (realUid === OLD_ID) {
    console.log('IDs já coincidem. Nenhuma ação necessária.');
    process.exit(0);
  }

  // Migra usuário
  const oldDoc = await db.collection('users').doc(OLD_ID).get();
  if (oldDoc.exists) {
    await db.collection('users').doc(realUid).set({ ...oldDoc.data(), id: realUid });
    console.log('users doc migrado para', realUid);
  }

  // Migra cobranças
  const charges = await db.collection('charges').where('tenantId', '==', OLD_ID).get();
  if (!charges.empty) {
    const batch = db.batch();
    charges.docs.forEach(d => batch.update(d.ref, { tenantId: realUid }));
    await batch.commit();
    console.log(`${charges.size} cobrança(s) migrada(s)`);
    charges.docs.forEach(d => console.log(' -', d.id, d.data().description || 'aluguel', d.data().totalAmount));
  }

  // Migra contratos
  const contracts = await db.collection('contracts').where('tenantId', '==', OLD_ID).get();
  if (!contracts.empty) {
    const batch2 = db.batch();
    contracts.docs.forEach(d => batch2.update(d.ref, { tenantId: realUid }));
    await batch2.commit();
    console.log(`${contracts.size} contrato(s) migrado(s)`);
  }

  // Remove doc antigo
  if (oldDoc.exists) {
    await db.collection('users').doc(OLD_ID).delete();
    console.log('Doc antigo removido:', OLD_ID);
  }

  console.log('Migração concluída!');
  process.exit(0);
})();
