const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('owners').get();
  snap.docs.forEach(d => {
    const data = d.data();
    console.log(d.id, '→ companyName:', data.companyName, '| name:', data.name, '| email:', data.email);
  });
  process.exit(0);
})();
