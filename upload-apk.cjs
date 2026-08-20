// Faz upload do APK para o Firebase Storage e retorna a URL pública
const admin = require('firebase-admin');
const { readFileSync } = require('fs');

const SA_PATH = 'C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json';
const BUCKET  = 'transgu-web-6d50f.firebasestorage.app'; // bucket usado pelo app
const APK_LOCAL = 'C:/locarpay-api/public/download/locarpay-v96.apk';
const APK_DEST  = 'download/locarpay-v96.apk';

const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
// Usa credencial do locarpayapp mas sobe no bucket do transgu-web-6d50f
// (mesmo bucket usado para lead docs — service account tem acesso)
const app = admin.initializeApp({ credential: admin.credential.cert(sa), storageBucket: BUCKET });
const bucket = admin.storage().bucket();

(async () => {
  console.log('Fazendo upload do APK para Firebase Storage...');
  await bucket.upload(APK_LOCAL, {
    destination: APK_DEST,
    metadata: {
      contentType: 'application/vnd.android.package-archive',
      cacheControl: 'public, max-age=31536000',
    },
  });
  // Torna o arquivo público
  const file = bucket.file(APK_DEST);
  await file.makePublic();
  const publicUrl = `https://storage.googleapis.com/${BUCKET}/${APK_DEST}`;
  console.log('✅ APK disponível em:', publicUrl);
  process.exit(0);
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
