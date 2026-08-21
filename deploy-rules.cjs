const { GoogleAuth } = require('google-auth-library');
const { readFileSync } = require('fs');
const https = require('https');

const PROJECT_ID = 'locarpayapp';
const SA_PATH = 'C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json';
const RULES_CONTENT = readFileSync('./firestore.rules', 'utf8');

async function deployRules() {
  const auth = new GoogleAuth({
    keyFile: SA_PATH,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;

  // 1. Cria o ruleset
  const rulesetBody = JSON.stringify({
    source: {
      files: [{ name: 'firestore.rules', content: RULES_CONTENT }]
    }
  });

  const ruleset = await request('POST',
    `/v1/projects/${PROJECT_ID}/rulesets`,
    token, rulesetBody);
  console.log('Ruleset criado:', ruleset.name);

  // 2. Atualiza o release cloud.firestore
  const releaseBody = JSON.stringify({
    release: {
      name: `projects/${PROJECT_ID}/releases/cloud.firestore`,
      rulesetName: ruleset.name
    }
  });

  await request('PATCH',
    `/v1/projects/${PROJECT_ID}/releases/cloud.firestore`,
    token, releaseBody);
  console.log('Regras implantadas com sucesso em', PROJECT_ID);
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

deployRules().catch(e => { console.error(e.message); process.exit(1); });
