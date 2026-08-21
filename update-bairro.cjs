const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  // Busca contratos com endereço da Rua Antonio Tavares Bueno
  const snap = await db.collectionGroup('contracts').get();
  const docs = snap.docs.filter(d => {
    const addr = d.getString?.('propertyAddress') ?? d.data().propertyAddress ?? '';
    return addr.includes('Tavares Bueno') || addr.includes('Antonio Tavares');
  });
  if (docs.length === 0) {
    console.log('Nenhum contrato encontrado com esse endereço.');
    process.exit(1);
  }
  for (const doc of docs) {
    await doc.ref.update({
      propertyNeighborhood: 'Residencial Santa Clara'
    });
    console.log(`Atualizado: ${doc.ref.path}`);
  }
  process.exit(0);
})();
