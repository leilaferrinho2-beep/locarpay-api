const admin = require('firebase-admin');
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({
  credential: admin.credential.cert(sa),
  storageBucket: 'locarpayapp.appspot.com'
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const versionCode = 335;
const versionName = '6.06';
const apkPath = 'C:/locarpay-api/public/download/ilocarpay.apk';
const destPath = 'apk/ilocarpay.apk';

(async () => {
  console.log('Fazendo upload do APK para Firebase Storage...');
  await bucket.upload(apkPath, {
    destination: destPath,
    metadata: {
      contentType: 'application/vnd.android.package-archive',
      cacheControl: 'public, max-age=0'
    }
  });

  // Gera URL pública permanente
  const file = bucket.file(destPath);
  await file.makePublic();
  const url = `https://storage.googleapis.com/locarpayapp.appspot.com/${destPath}`;
  console.log('URL pública:', url);

  // Atualiza Firestore config/app
  await db.collection('config').doc('app').set({ versionCode, versionName, url });

  // Atualiza arquivos version.json
  const payload = JSON.stringify({ versionCode, versionName, url }, null, 2);
  writeFileSync('version.json', payload);
  writeFileSync('public/version.json', payload);

  console.log(`config/app atualizado: ${versionCode} / ${versionName}`);
  console.log('URL de download:', url);
  process.exit(0);
})();
