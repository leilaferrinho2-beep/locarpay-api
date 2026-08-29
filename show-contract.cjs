const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  const c = (await db.collection('contracts').doc('DvNjukoPCk30OrQT2dqy').get()).data();
  console.log(JSON.stringify(c, null, 2));
  process.exit(0);
})();
