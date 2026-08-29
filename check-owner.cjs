const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  console.log('=== OWNERS ===');
  const owners = await db.collection('owners').limit(20).get();
  owners.docs.forEach(d => {
    const data = d.data();
    console.log(`ID: ${d.id} | name: "${data.name || ''}" | email: "${data.email || ''}" | status: ${data.status || ''}`);
  });

  console.log('\n=== BROKERS ===');
  const brokers = await db.collection('brokers').limit(20).get();
  brokers.docs.forEach(d => {
    const data = d.data();
    console.log(`ID: ${d.id} | name: "${data.name || ''}" | email: "${data.email || ''}" | ownerId: "${data.ownerId || ''}"`);
  });
  process.exit(0);
})();
