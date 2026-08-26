const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const ASAAS_ID = 'pay_6dam4cfdgih12qus';

(async () => {
  const cfg = await db.collection('config').doc('asaas').get();
  const apiKey = cfg.data()?.apiKey;
  const https = require('https');
  const r = await new Promise((res, rej) => {
    const req = https.request({
      hostname: 'www.asaas.com',
      path: `/api/v3/payments/${ASAAS_ID}`,
      method: 'DELETE',
      headers: { 'access_token': apiKey, 'User-Agent': 'iLocarPay/1.0' }
    }, resp => {
      let out = '';
      resp.on('data', d => out += d);
      resp.on('end', () => res({ status: resp.statusCode, body: out }));
    });
    req.on('error', rej);
    req.end();
  });
  console.log('Status:', r.status);
  console.log('Response:', r.body.substring(0, 150));
  process.exit(0);
})();
