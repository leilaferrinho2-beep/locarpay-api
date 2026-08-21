const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  // Busca o tenantId da Gabriela
  const users = await db.collection('users').where('email', '==', 'gabrielaishimoto@gmail.com').limit(1).get();
  if (users.empty) { console.error('Gabriela não encontrada'); process.exit(1); }
  const gabriela = users.docs[0];
  console.log('Gabriela uid:', gabriela.id);

  await db.collection('messages').add({
    authorId: 'owner',
    authorName: 'iLocarPay',
    tenantId: gabriela.id,
    text: '📲 Nova versão do app disponível! Acesse o link abaixo para atualizar:\nhttps://www.ilocarpay.com.br/download/locarpay-v212.apk',
    createdAt: admin.firestore.Timestamp.now()
  });
  console.log('Mensagem enviada para Gabriela!');
  process.exit(0);
})();
