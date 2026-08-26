const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const TENANT_ID = 'LD7zmbQFxuT6rGfSAHVcOM3LP7I2';
const OWNER_ID  = 'z0MhNh4DzXFc1yl61BQr'; // Ferrinho Imóveis

(async () => {
  // Busca todas as cobranças sem ownerId deste inquilino
  const charges = await db.collection('charges').where('tenantId', '==', TENANT_ID).get();
  const batch = db.batch();
  let count = 0;
  charges.docs.forEach(d => {
    const data = d.data();
    if (!data.ownerId) {
      console.log(`Corrigindo: ${d.id} | ${data.description || data.type || 'aluguel'} | R$${data.totalAmount} | ownerId: undefined → ${OWNER_ID}`);
      batch.update(d.ref, { ownerId: OWNER_ID });
      count++;
    } else {
      console.log(`OK: ${d.id} | ownerId já definido: ${data.ownerId}`);
    }
  });

  if (count > 0) {
    await batch.commit();
    console.log(`\n${count} cobrança(s) corrigida(s).`);
  } else {
    console.log('\nNenhuma cobrança para corrigir.');
  }
  process.exit(0);
})();
