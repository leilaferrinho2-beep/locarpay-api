// Testa qual verification_method é válido na conta Assinafy
const admin = require('firebase-admin');
const sa = JSON.parse(require('fs').readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const BASE = 'https://api.assinafy.com.br/v1';

async function req(method, path, body, apiKey) {
  const r = await fetch(`${BASE}/${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; } catch { return { status: r.status, data: text }; }
}

(async () => {
  const snap = await db.collection('config').doc('assinafy').get();
  const apiKey = snap.data()?.apiKey;
  if (!apiKey) { console.error('Chave Assinafy não encontrada em config/assinafy'); process.exit(1); }
  console.log('API Key encontrada ✓');

  // Busca account
  const accs = await req('GET', 'accounts', null, apiKey);
  const accountId = accs.data?.data?.[0]?.id;
  console.log('Account ID:', accountId);

  // Busca um documento existente para testar assignment
  const docs = await req('GET', `accounts/${accountId}/documents?limit=5`, null, apiKey);
  const docId = docs.data?.data?.[0]?.id;
  console.log('Documento existente:', docId);
  if (!docId) { console.log('Nenhum documento encontrado para teste'); process.exit(0); }

  // Testa criar signer
  const ts = Date.now();
  const s1 = await req('POST', `accounts/${accountId}/signers`, { full_name: `Teste ${ts}`, email: `teste${ts}@ilocarpay.com.br` }, apiKey);
  const s1Id = s1.data?.data?.id || s1.data?.id;
  console.log('Signer criado:', s1Id);

  // Testa diferentes verification_method
  const methods = ['email', 'Email', 'EMAIL', 'selfie', 'Selfie', 'biometric', 'Biometric', 'sms', 'none', 'None'];
  for (const vm of methods) {
    const r = await req('POST', `documents/${docId}/assignments`, {
      method: 'virtual',
      message: 'Teste',
      signers: [{ id: s1Id, step: 1, action: 'sign', verification_method: vm, notification_methods: ['Email'] }]
    }, apiKey);
    console.log(`  verification_method: '${vm}' → ${r.status} ${r.status === 200 || r.status === 201 ? '✓ VÁLIDO' : JSON.stringify(r.data?.message || r.data)}`);
    if (r.status === 200 || r.status === 201) break;
  }

  process.exit(0);
})();
