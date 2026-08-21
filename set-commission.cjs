// Define commission/commissionPct para os corretores que ainda não têm o campo
// Edite PCT abaixo para a porcentagem desejada (ex: 5 = 5%)
const PCT = 5;

const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('brokers').get();
  console.log(`Corretores encontrados: ${snap.size}`);
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.commission === undefined && d.commissionPct === undefined) {
      await doc.ref.update({ commission: PCT, commissionPct: PCT });
      console.log(`✓ ${d.email} → ${PCT}%`);
    } else {
      console.log(`- ${d.email} já tem commission=${d.commission} / commissionPct=${d.commissionPct} (não alterado)`);
    }
  }
  console.log('Pronto.');
  process.exit(0);
})();
