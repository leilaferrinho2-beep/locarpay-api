const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  // Corrige broker denisfelicio2 para apontar para owner existente "Felicio Imoveis"
  const correctOwnerId = '0afVvfuTUm60Fsxqt5qP';
  await db.collection('brokers').doc('denisfelicio2_gmail_com_2qPJ2B').update({ ownerId: correctOwnerId });
  console.log('Broker denisfelicio2 corrigido → ownerId:', correctOwnerId);

  // Verifica o nome do owner
  const ownerDoc = await db.collection('owners').doc(correctOwnerId).get();
  console.log('Owner name:', ownerDoc.data()?.name);
  process.exit(0);
})();
