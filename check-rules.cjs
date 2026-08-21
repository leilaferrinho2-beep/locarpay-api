const { GoogleAuth } = require('google-auth-library');
const https = require('https');

const PROJECT_ID = 'locarpayapp';
const SA_PATH = 'C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json';

async function checkRules() {
  const auth = new GoogleAuth({ keyFile: SA_PATH, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;

  // Busca o release atual do cloud.firestore
  const release = await get(token, `/v1/projects/${PROJECT_ID}/releases/cloud.firestore`);
  console.log('Release atual:', release.rulesetName);

  // Busca o conteúdo do ruleset
  const ruleset = await get(token, `/v1/${release.rulesetName}`);
  const content = ruleset.source?.files?.[0]?.content || '';
  console.log('\n=== REGRAS EM PRODUÇÃO ===');
  // Mostra só as linhas com brokerChats ou a ausência delas
  const lines = content.split('\n');
  const relevant = lines.filter(l => l.includes('brokerChat') || l.includes('broker') || l.includes('default'));
  console.log(relevant.length ? relevant.join('\n') : 'SEM REGRAS brokerChats!');
}

function get(token, path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'firebaserules.googleapis.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` } };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => res.statusCode >= 400 ? reject(new Error(`${res.statusCode}: ${data}`)) : resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

checkRules().catch(e => console.error(e.message));
