const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  const doc = await db.collection('config').doc('app').get();
  console.log('config/app:', JSON.stringify(doc.data(), null, 2));
  process.exit(0);
})();
