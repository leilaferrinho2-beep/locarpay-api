const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  await db.collection('config').doc('app').set({
    versionCode: 248,
    versionName: '5.28',
    url: 'https://www.ilocarpay.com.br/download/locarpay-v86.apk'
  });
  console.log('config/app atualizado: 248 / 5.28 (locarpayapp)');
  process.exit(0);
})();
