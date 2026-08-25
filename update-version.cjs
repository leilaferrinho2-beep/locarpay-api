const admin = require('firebase-admin');
const { readFileSync, writeFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const versionCode = 291;
const versionName = '5.65';
const url = 'https://www.ilocarpay.com.br/download/locarpay-v107.apk';
(async () => {
  await db.collection('config').doc('app').set({ versionCode, versionName, url });
  writeFileSync('version.json', JSON.stringify({ versionCode, versionName, url }, null, 2));
  console.log(`config/app atualizado: ${versionCode} / ${versionName} (locarpay-v82)`);
  process.exit(0);
})();
