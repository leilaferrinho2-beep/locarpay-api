const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const UID = 'LD7zmbQFxuT6rGfSAHVcOM3LP7I2';
const CHARGE_ID = 'yOwA31YiSAfEJAI9NAzb'; // aluguel 403

(async () => {
  const [userDoc, chargeDoc] = await Promise.all([
    db.collection('users').doc(UID).get(),
    db.collection('charges').doc(CHARGE_ID).get(),
  ]);

  const user = userDoc.data();
  const charge = chargeDoc.data();

  console.log('=== USER ===');
  console.log('ownerId:', user.ownerId);
  console.log('role:', user.role);
  console.log('email:', user.email);

  console.log('\n=== CHARGE (aluguel) ===');
  console.log('ownerId:', charge.ownerId);
  console.log('tenantId:', charge.tenantId);
  console.log('description:', charge.description);
  console.log('totalAmount:', charge.totalAmount);
  console.log('status:', charge.status);

  console.log('\n=== PROBLEMA ===');
  if (user.ownerId && charge.ownerId && user.ownerId !== charge.ownerId) {
    console.log('ownerId diverge! user.ownerId:', user.ownerId, '!= charge.ownerId:', charge.ownerId);
  } else if (!charge.ownerId) {
    console.log('Cobrança sem ownerId! Precisa definir.');
  } else {
    console.log('ownerIds coincidem:', user.ownerId, '==', charge.ownerId);
  }

  // Busca todos os owners para referência
  const owners = await db.collection('owners').get();
  console.log('\n=== OWNERS disponíveis ===');
  owners.docs.forEach(d => console.log(d.id, '-', d.data().name));

  process.exit(0);
})();
