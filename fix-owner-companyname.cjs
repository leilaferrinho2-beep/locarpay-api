const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  await db.collection('owners').doc('0afVvfuTUm60Fsxqt5qP').update({
    companyName: 'Felicio Imoveis'
  });
  console.log('companyName atualizado para: Felicio Imoveis');
  process.exit(0);
})();
