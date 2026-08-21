const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  // Todos os corretores
  const brokers = await db.collection('brokers').get();
  console.log(`\n=== BROKERS (${brokers.size}) ===`);
  brokers.forEach(d => {
    const data = d.data();
    console.log(`ID: ${d.id}`);
    console.log(`  email: ${data.email}`);
    console.log(`  ownerId: ${data.ownerId}`);
    console.log(`  commission: ${data.commission}`);
    console.log(`  commissionPct: ${data.commissionPct}`);
    console.log(`  fcmToken: ${data.fcmToken ? 'SIM' : 'NÃO'}`);
  });

  // brokerChats existentes
  const chats = await db.collection('brokerChats').get();
  console.log(`\n=== BROKER CHATS (${chats.size}) ===`);
  chats.forEach(d => {
    const data = d.data();
    console.log(`ID: ${d.id}`);
    console.log(`  ownerId: ${data.ownerId}, brokerId: ${data.brokerId}`);
    console.log(`  lastMessage: ${data.lastMessage}`);
  });

  // owners
  const owners = await db.collection('owners').limit(3).get();
  console.log(`\n=== OWNERS (${owners.size}) ===`);
  owners.forEach(d => {
    const data = d.data();
    console.log(`ID: ${d.id} | email: ${data.email} | company: ${data.companyName}`);
  });

  process.exit(0);
})();
