const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const TENANT_ID = 'Lb0p9HLX3uO5iCfAztIZ8sHf3b92';
const OWNER_ID  = '0afVvfuTUm60Fsxqt5qP'; // Felicio Imoveis

// MANTER: a cobrança com PIX gerado mais antiga (0KNK...)
// DELETAR: as 3 duplicatas
const KEEP_ID    = '0KNK3HVnZSUKDBKmUbUx';
const DELETE_IDS = [
  '23jReiHV9sdcOKlgJ1an', // duplicata com PIX — cancela no Asaas primeiro
  'atx5vcbMszz9IlJa5erx', // duplicata sem PIX
  'qKAyFc5hF1wfoihRkuPU', // duplicata sem PIX
];
const ASAAS_CANCEL_ID = 'pay_6dam4cfdgih12qus'; // asaasChargeId da 23jRei...

async function asaasReq(method, path, body, apiKey) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'www.asaas.com',
      path: `/api/v3${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'access_token': apiKey,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, data: out }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // Busca chave Asaas do owner
  const ownerDoc = await db.collection('owners').doc(OWNER_ID).get();
  const asaasKey = ownerDoc.data()?.asaasApiKey;
  if (!asaasKey) {
    // fallback: config/asaas legado
    const cfg = await db.collection('config').doc('asaas').get();
    const key = cfg.data()?.apiKey;
    if (!key) { console.error('Chave Asaas não encontrada'); process.exit(1); }
    console.log('Usando chave legada config/asaas');
    await run(key);
  } else {
    await run(asaasKey);
  }

  async function run(apiKey) {
    // Cancela no Asaas a duplicata que tem PIX gerado
    console.log('Cancelando no Asaas:', ASAAS_CANCEL_ID);
    const cancel = await asaasReq('DELETE', `/payments/${ASAAS_CANCEL_ID}`, null, apiKey);
    console.log('Asaas response:', cancel.status, JSON.stringify(cancel.data).substring(0, 80));

    // Deleta as 3 cobranças duplicadas do Firestore
    const batch = db.batch();
    DELETE_IDS.forEach(id => batch.delete(db.collection('charges').doc(id)));
    await batch.commit();
    console.log(`${DELETE_IDS.length} cobranças deletadas do Firestore:`, DELETE_IDS);

    // Confirma o que ficou
    const remaining = await db.collection('charges').where('tenantId', '==', TENANT_ID).get();
    console.log('\nCobranças restantes:', remaining.size);
    remaining.docs.forEach(d => {
      const c = d.data();
      const due = c.dueDate?.seconds ? new Date(c.dueDate.seconds*1000).toLocaleDateString('pt-BR') : '?';
      console.log(`  ${d.id} | R$${c.totalAmount} | ${c.status} | vence ${due} | ${c.description || 'aluguel'}`);
    });
    process.exit(0);
  }
})();
