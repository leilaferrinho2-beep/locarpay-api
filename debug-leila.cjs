const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  // Acha a Leila pelo email
  const users = await db.collection('users').where('role', '==', 'tenant').get();
  const leila = users.docs.find(d => {
    const n = (d.data().name || '').toLowerCase();
    const e = (d.data().email || '').toLowerCase();
    return n.includes('leila') || e.includes('leila');
  });

  if (!leila) { console.log('Inquilina Leila não encontrada'); process.exit(1); }
  console.log('=== LEILA ===');
  console.log('ID:', leila.id);
  console.log('Nome:', leila.data().name);
  console.log('Email:', leila.data().email);
  console.log('ownerId:', leila.data().ownerId);

  const charges = await db.collection('charges').where('tenantId', '==', leila.id).get();
  console.log(`\nTotal de cobranças: ${charges.size}`);
  charges.docs.sort((a,b) => (a.data().dueDate?.seconds||0) - (b.data().dueDate?.seconds||0))
    .forEach(d => {
      const c = d.data();
      const due = c.dueDate?.seconds ? new Date(c.dueDate.seconds*1000).toLocaleDateString('pt-BR') : '?';
      console.log(`\n  ID: ${d.id}`);
      console.log(`  desc: ${c.description || c.type || '—'}`);
      console.log(`  totalAmount: R$${c.totalAmount}`);
      console.log(`  baseRent: R$${c.baseRent}`);
      console.log(`  status: ${c.status}`);
      console.log(`  dueDate: ${due}`);
      console.log(`  asaasChargeId: ${c.asaasChargeId || '—'}`);
      console.log(`  pixCopyPaste: ${c.pixCopyPaste ? c.pixCopyPaste.substring(0,20)+'...' : 'vazio'}`);
      console.log(`  monthRef: ${c.monthRef || '—'}`);
      console.log(`  createdAt: ${c.createdAt?.seconds ? new Date(c.createdAt.seconds*1000).toLocaleString('pt-BR') : '—'}`);
    });
  process.exit(0);
})();
