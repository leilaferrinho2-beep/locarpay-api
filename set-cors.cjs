const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa), storageBucket: 'transgu-web-6d50f.firebasestorage.app' });

(async () => {
  const bucket = admin.storage().bucket();
  await bucket.setCorsConfiguration([{
    maxAgeSeconds: 3600,
    method: ['PUT', 'GET', 'HEAD', 'DELETE'],
    origin: ['https://www.ilocarpay.com.br', 'https://ilocarpay.com.br', 'http://localhost:3000'],
    responseHeader: ['Content-Type', 'Content-Length', 'Authorization', 'x-goog-resumable']
  }]);
  console.log('✅ CORS configurado no bucket transgu-web-6d50f.firebasestorage.app');
  process.exit(0);
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
