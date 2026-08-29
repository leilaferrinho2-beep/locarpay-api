const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const ferrinhoOwnerId = 'z0MhNh4DzXFc1yl61BQr';
  const email = 'denisfelicio2@gmail.com';
  const docId = 'denisfelicio2_gmail_com_z0MhNh';

  // Verifica se já existe
  const existing = await db.collection('brokers').doc(docId).get();
  if (existing.exists) {
    console.log('Broker já existe:', existing.data());
    process.exit(0);
  }

  // Busca dados do broker existente para copiar nome etc.
  const ref = await db.collection('brokers').doc('denisfelicio2_gmail_com_2qPJ2B').get();
  const data = ref.data() || {};

  await db.collection('brokers').doc(docId).set({
    ...data,
    email,
    ownerId: ferrinhoOwnerId,
  });

  console.log('Broker denisfelicio2 → Ferrinho Imóveis criado:', docId);

  // Também garante que ownerIds está atualizado no doc principal
  const ownerIds = ['0afVvfuTUm60Fsxqt5qP', ferrinhoOwnerId];
  await db.collection('brokers').doc('denisfelicio2_gmail_com_2qPJ2B').update({ ownerIds });
  console.log('ownerIds atualizado no broker principal:', ownerIds);

  process.exit(0);
})();
