const { put } = require('@vercel/blob');
const { readFileSync, writeFileSync } = require('fs');
const admin = require('firebase-admin');

// Carrega token do .env.local sem expor
const envContent = readFileSync('.env.local', 'utf8');
const tokenMatch = envContent.match(/BLOB_READ_WRITE_TOKEN=([^\r\n]+)/);
if (!tokenMatch) { console.error('BLOB_READ_WRITE_TOKEN não encontrado'); process.exit(1); }
process.env.BLOB_READ_WRITE_TOKEN = tokenMatch[1].trim().replace(/^"|"$/g, '');

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const versionCode = 350;
const versionName = '6.21';
const apkBuffer = readFileSync('C:/LocarPay/app/build/outputs/apk/release/app-release.apk');

(async () => {
  console.log('Fazendo upload para Vercel Blob...');
  const blob = await put('app-release.apk', apkBuffer, {
    access: 'public',
    contentType: 'application/vnd.android.package-archive',
    addRandomSuffix: false,
    allowOverwrite: true,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  const url = blob.url;
  console.log('URL Blob:', url);

  await db.collection('config').doc('app').set({ versionCode, versionName, url });

  const payload = JSON.stringify({ versionCode, versionName, url }, null, 2);
  writeFileSync('version.json', payload);
  writeFileSync('public/version.json', payload);

  console.log(`config/app e version.json atualizados: ${versionCode} / ${versionName}`);
  console.log('DONE');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
