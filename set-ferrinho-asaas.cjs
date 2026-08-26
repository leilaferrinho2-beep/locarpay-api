const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const FERRINHO_ID = 'z0MhNh4DzXFc1yl61BQr';
const FELICIO_ID  = '0afVvfuTUm60Fsxqt5qP';

(async () => {
  // Lê chave legada do config/asaas
  const legacySnap = await db.collection('config').doc('asaas').get();
  if (!legacySnap.exists) { console.error('config/asaas não existe'); process.exit(1); }
  const legacyKey = legacySnap.data().apiKey;
  if (!legacyKey) { console.error('apiKey ausente no config/asaas'); process.exit(1); }

  console.log('Chave Asaas (Felicio Imóveis):', legacyKey.substring(0, 20) + '...');

  // Define a chave tanto no Felicio quanto no Ferrinho
  await db.collection('owners').doc(FELICIO_ID).update({ asaasApiKey: legacyKey });
  console.log('Felicio Imóveis asaasApiKey: atualizado');

  await db.collection('owners').doc(FERRINHO_ID).update({ asaasApiKey: legacyKey });
  console.log('Ferrinho Imóveis asaasApiKey: atualizado');

  console.log('\nAmbas imobiliárias agora usam a conta Asaas do Felício Imóveis.');
  process.exit(0);
})();
