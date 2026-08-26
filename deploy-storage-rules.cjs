const { GoogleAuth } = require('google-auth-library');
const { readFileSync } = require('fs');
const https = require('https');

const PROJECT_ID = 'locarpayapp';
const SA_PATH = 'C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json';
const RULES_CONTENT = readFileSync('./storage.rules', 'utf8');

async function deployStorageRules() {
  const auth = new GoogleAuth({
    keyFile: SA_PATH,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;

  const rulesetBody = JSON.stringify({
    source: {
      files: [{ name: 'storage.rules', content: RULES_CONTENT }]
    }
  });

  const ruleset = await request('POST',
    `/v1/projects/${PROJECT_ID}/rulesets`,
    token, rulesetBody);
  console.log('Ruleset criado:', ruleset.name);

  // POST para criar o release (Storage rules)
  const createBody = JSON.stringify({
    name: `projects/${PROJECT_ID}/releases/firebase.storage/locarpayapp.firebasestorage.app`,
    rulesetName: ruleset.name
  });
  await request('POST', `/v1/projects/${PROJECT_ID}/releases`, token, createBody);
  console.log('Regras de Storage implantadas com sucesso!');
}

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'firebaserules.googleapis.com',
      path, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        else resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

deployStorageRules().catch(e => { console.error(e.message); process.exit(1); });
