const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const owners = await db.collection('owners').get();
  owners.docs.forEach(d => {
    const data = d.data();
    console.log('\n===', d.id, '-', data.name, '===');
    console.log('email:', data.email);
    console.log('asaasApiKey:', data.asaasApiKey ? data.asaasApiKey.substring(0, 20) + '...' : 'NÃO DEFINIDO');
    console.log('asaasWalletId:', data.asaasWalletId || 'não definido');
    console.log('plan:', data.plan);
  });

  // Busca config/asaas legado
  const legacyAsaas = await db.collection('config').doc('asaas').get();
  console.log('\n=== config/asaas (legado) ===');
  if (legacyAsaas.exists) {
    const d = legacyAsaas.data();
    console.log('apiKey:', d.apiKey ? d.apiKey.substring(0, 20) + '...' : 'ausente');
  } else {
    console.log('não existe');
  }
  process.exit(0);
})();
