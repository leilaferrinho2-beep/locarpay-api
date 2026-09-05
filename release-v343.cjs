const admin = require('firebase-admin');
const { readFileSync } = require('fs');

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const versionCode = 343;
const versionName = '6.14';
const url = 'https://gkrav8ckclxpbeho.public.blob.vercel-storage.com/app-release.apk';

(async () => {
  await db.collection('config').doc('app').set({ versionCode, versionName, url });
  console.log(`config/app atualizado: ${versionCode} / ${versionName}`);
  console.log(`url: ${url}`);
  process.exit(0);
})();
