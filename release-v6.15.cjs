/**
 * release-v6.15.cjs — Upload APK 344 / 6.15 para Vercel Blob + Firestore
 * USO ÚNICO: release do ícone centralizado.
 */

const { put } = require('@vercel/blob');
const { readFileSync, writeFileSync } = require('fs');
const admin = require('firebase-admin');

const VERSION_CODE = 344;
const VERSION_NAME = '6.15';
const APK_PATH = 'C:/locarpay-api/public/download/ilocarpay.apk';

// Lê BLOB_READ_WRITE_TOKEN do .env.local
const envContent = readFileSync('.env.local', 'utf8');
const tokenMatch = envContent.match(/BLOB_READ_WRITE_TOKEN=([^\r\n]+)/);
if (!tokenMatch) { console.error('BLOB_READ_WRITE_TOKEN não encontrado em .env.local'); process.exit(1); }
process.env.BLOB_READ_WRITE_TOKEN = tokenMatch[1].trim().replace(/^["']|["']$/g, '');

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const apkBuffer = readFileSync(APK_PATH);
  console.log(`APK local: ${(apkBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  // 1. Upload para Vercel Blob (sobrescreve app-release.apk)
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

  // 2. Atualiza Firestore config/app
  await db.collection('config').doc('app').set({ versionCode: VERSION_CODE, versionName: VERSION_NAME, url });
  console.log(`Firestore config/app: ${VERSION_CODE} / ${VERSION_NAME}`);

  // 3. Atualiza version.json local (serve /api/version)
  const payload = JSON.stringify({ versionCode: VERSION_CODE, versionName: VERSION_NAME, url }, null, 2);
  writeFileSync('version.json', payload);
  writeFileSync('public/version.json', payload);
  console.log('version.json atualizado');

  console.log('\nDONE — release v6.15 / 344 publicada');
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
