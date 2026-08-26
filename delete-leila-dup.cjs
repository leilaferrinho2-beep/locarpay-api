const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const OWNER_ID    = '0afVvfuTUm60Fsxqt5qP'; // Felicio Imoveis
const DELETE_ID   = 'AZ6Qyu7aNDbYsRyg3uND';
const ASAAS_ID    = 'pay_6tl2mzviz80dpys9';
const TENANT_ID   = 'Lb0p9HLX3uO5iCfAztIZ8sHf3b92';

async function asaasReq(method, path, apiKey) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.asaas.com',
      path: `/api/v3${path}`,
      method,
      headers: { 'access_token': apiKey, 'User-Agent': 'iLocarPay/1.0' }
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, data: out }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const ownerDoc = await db.collection('owners').doc(OWNER_ID).get();
  const apiKey = ownerDoc.data()?.asaasApiKey;
  if (!apiKey) { console.error('Chave Asaas não encontrada'); process.exit(1); }

  console.log('Cancelando no Asaas:', ASAAS_ID);
  const cancel = await asaasReq('DELETE', `/payments/${ASAAS_ID}`, apiKey);
  console.log('Asaas status:', cancel.status, JSON.stringify(cancel.data).substring(0, 100));

  console.log('Deletando do Firestore:', DELETE_ID);
  await db.collection('charges').doc(DELETE_ID).delete();
  console.log('Deletado.');

  const remaining = await db.collection('charges').where('tenantId', '==', TENANT_ID).get();
  console.log('\nCobranças restantes:', remaining.size);
  remaining.docs.sort((a,b) => (a.data().dueDate?.seconds||0) - (b.data().dueDate?.seconds||0)).forEach(d => {
    const c = d.data();
    const due = c.dueDate?.seconds ? new Date(c.dueDate.seconds*1000).toLocaleDateString('pt-BR') : '?';
    console.log(`  ${d.id} | R$${c.totalAmount} | ${c.status} | vence ${due} | monthRef: ${c.monthRef||'—'}`);
  });
  process.exit(0);
})();
