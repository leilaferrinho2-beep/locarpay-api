const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  // Busca leads aprovados recentemente com erro ou sem contrato Assinafy
  const leads = await db.collection('leads')
    .where('status', '==', 'approved')
    .limit(10)
    .get();

  console.log('=== LEADS APROVADOS RECENTES ===');
  for (const d of leads.docs) {
    const data = d.data();
    console.log(`\nLead: ${d.id}`);
    console.log(`  Inquilino: ${data.tenant?.name} (${data.tenant?.email})`);
    console.log(`  contractId: ${data.contractId || 'AUSENTE'}`);
    console.log(`  contractStatus: ${data.contractStatus || 'AUSENTE'}`);

    if (data.contractId) {
      const contract = await db.collection('contracts').doc(data.contractId).get();
      if (contract.exists) {
        const c = contract.data();
        console.log(`  assinafyStatus: ${c.assinafyStatus}`);
        console.log(`  assinafyError: ${c.assinafyError || 'nenhum'}`);
        console.log(`  assinafyDocumentId: ${c.assinafyDocumentId || 'AUSENTE'}`);
        console.log(`  landlordEmail: ${c.landlordEmail || 'AUSENTE'}`);
        console.log(`  tenantEmail: ${c.tenantEmail || 'AUSENTE'}`);
      } else {
        console.log('  CONTRATO NAO ENCONTRADO no Firestore');
      }
    }
  }
  process.exit(0);
})();
