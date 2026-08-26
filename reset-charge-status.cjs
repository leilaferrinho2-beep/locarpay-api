const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// Cobrança da Marisa: aluguel R$5,71 estornado
const CHARGE_ID = 'yOwA31YiSAfEJAI9NAzb';

(async () => {
  const doc = await db.collection('charges').doc(CHARGE_ID).get();
  const data = doc.data();
  console.log('Status atual:', data.status);
  console.log('paidAt:', data.paidAt?.toDate?.() || data.paidAt);
  console.log('asaasChargeId:', data.asaasChargeId);
  console.log('totalAmount:', data.totalAmount);
  console.log('dueDate:', data.dueDate?.toDate?.() || data.dueDate);

  // Reset: status overdue (venceu ontem), limpa dados de pagamento
  await db.collection('charges').doc(CHARGE_ID).update({
    status:        'overdue',
    paidAt:        null,
    refundedAt:    new Date(),
    refundNote:    'estornado externamente no painel Asaas (resetado manualmente)',
    asaasChargeId: '',
    pixCopyPaste:  '',
    pixQrCode:     '',
  });

  console.log('\nCobrança resetada para overdue. Inquilina precisará gerar novo PIX no app.');
  process.exit(0);
})();
