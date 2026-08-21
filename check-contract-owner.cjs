const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('contracts').get();
  snap.docs.forEach(d => {
    const data = d.data();
    console.log(d.id, '→ ownerId:', data.ownerId, '| tenantEmail:', data.tenantEmail);
  });
  process.exit(0);
})();
