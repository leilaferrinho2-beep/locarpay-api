const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  // Corrige contrato da Gabriela
  const contractSnap = await db.collection('contracts')
    .where('tenantEmail', '==', 'gabrielaishimoto@gmail.com').get();
  for (const doc of contractSnap.docs) {
    const data = doc.data();
    console.log(`Contrato ${doc.id}: baseRent atual = ${data.baseRent}`);
    await doc.ref.update({ baseRent: 500 });
    console.log(`→ Corrigido para 500`);
  }

  // Corrige cobranças da Gabriela
  const chargesSnap = await db.collection('charges')
    .where('tenantEmail', '==', 'gabrielaishimoto@gmail.com').get();
  for (const doc of chargesSnap.docs) {
    const data = doc.data();
    console.log(`Cobrança ${doc.id}: baseRent=${data.baseRent} totalAmount=${data.totalAmount}`);
    await doc.ref.update({
      baseRent: 500,
      totalAmount: 500,
      pixCopyPaste: null,
      pixQrCode: null,
      asaasChargeId: null,
      pixGeneratedDate: null
    });
    console.log(`→ Corrigido para 500, QR resetado`);
  }

  process.exit(0);
})();
