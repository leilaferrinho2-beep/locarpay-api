const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  await db.collection('config').doc('app').set({
    versionCode: 260,
    versionName: '5.35',
    url: 'https://storage.googleapis.com/transgu-web-6d50f.firebasestorage.app/download/locarpay-v96.apk'
  });
  console.log('config/app atualizado: 260 / 5.35 (locarpay-v96)');
  process.exit(0);
})();
