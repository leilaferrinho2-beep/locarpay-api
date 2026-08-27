const admin = require('firebase-admin');
const { readFileSync, writeFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const versionCode = 302;
const versionName = '5.76';
const url = 'https://storage.googleapis.com/transgu-web-6d50f.firebasestorage.app/apk/locarpay-v118.apk';
(async () => {
  await db.collection('config').doc('app').set({ versionCode, versionName, url });
  const payload = JSON.stringify({ versionCode, versionName, url }, null, 2);
  writeFileSync('version.json', payload);
  writeFileSync('public/version.json', payload);
  console.log(`config/app atualizado: ${versionCode} / ${versionName}`);
  process.exit(0);
})();
