// Busca cardVerifications recentes e estorna microPaymentId na Asaas
// Uso: node refund-micro.cjs
const SA = require('./.service-account.json');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

initializeApp({ credential: cert(SA) });
const db = getFirestore();

async function asaasRefund(paymentId, apiKey, value) {
  const url = `https://api.asaas.com/v3/payments/${paymentId}/refund`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': apiKey },
    body: JSON.stringify(value ? { value } : {})
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(json));
  return json;
}

async function main() {
  // Busca as 10 verificações mais recentes ainda não completamente verificadas
  const snap = await db.collection('cardVerifications')
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();

  // Busca a chave Asaas do owner padrão
  const ownerSnap = await db.collection('owners').limit(1).get();
  let apiKey = '';
  if (!ownerSnap.empty) {
    apiKey = ownerSnap.docs[0].data().asaasApiKey || '';
  }
  if (!apiKey) {
    // fallback: busca em config
    const cfg = await db.collection('config').doc('asaas').get();
    apiKey = cfg.data()?.apiKey || '';
  }
  if (!apiKey) { console.error('Chave Asaas não encontrada'); process.exit(1); }

  for (const doc of snap.docs) {
    const v = doc.data();
    console.log(`\n[${doc.id}]`);
    console.log(`  microPaymentId : ${v.microPaymentId}`);
    console.log(`  microAmount    : ${v.microAmount}`);
    console.log(`  amountVerified : ${v.amountVerified}`);
    console.log(`  createdAt      : ${v.createdAt?.toDate?.()}`);

    if (!v.microPaymentId) { console.log('  → sem microPaymentId, pulando'); continue; }

    try {
      const res = await asaasRefund(v.microPaymentId, apiKey, v.microAmount);
      console.log('  ✓ estornado:', JSON.stringify(res));
    } catch (e) {
      console.log('  ✗ erro:', e.message);
    }
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
