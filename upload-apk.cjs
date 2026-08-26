const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const path = require('path');

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({
  credential: admin.credential.cert(sa),
  storageBucket: 'locarpayapp.appspot.com'
});

const bucket = admin.storage().bucket();
const apkPath = 'C:/locarpay-api/public/download/locarpay-v109.apk';
const destPath = 'download/locarpay-v109.apk';

(async () => {
  console.log('Enviando APK para Firebase Storage...');
  await bucket.upload(apkPath, {
    destination: destPath,
    metadata: {
      contentType: 'application/vnd.android.package-archive',
      cacheControl: 'public, max-age=31536000'
    }
  });

  // Gera URL pública (sem expiração)
  const file = bucket.file(destPath);
  await file.makePublic();
  const url = `https://storage.googleapis.com/locarpayapp.firebasestorage.app/${destPath}`;
  console.log('URL pública:', url);

  // Atualiza Firestore
  const db = admin.firestore();
  const versionCode = 293;
  const versionName = '5.67';
  await db.collection('config').doc('app').set({ versionCode, versionName, url });

  // Atualiza version.json
  const { writeFileSync } = require('fs');
  const payload = JSON.stringify({ versionCode, versionName, url }, null, 2);
  writeFileSync('version.json', payload);
  writeFileSync('public/version.json', payload);
  console.log(`Firestore e version.json atualizados: ${versionCode} / ${versionName}`);
  process.exit(0);
})();
