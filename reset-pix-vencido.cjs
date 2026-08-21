const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('charges').get();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let count = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const due = data.dueDate?.toDate?.() || (data.dueDate?.seconds ? new Date(data.dueDate.seconds * 1000) : null);
    if (due && due < today) {
      await doc.ref.update({ pixCopyPaste: null, pixQrCode: null, asaasChargeId: null, pixGeneratedDate: null });
      console.log(`Resetado: ${doc.id} (vencimento: ${due.toISOString().slice(0,10)})`);
      count++;
    }
  }
  console.log(`Total resetado: ${count}`);
  process.exit(0);
})();
