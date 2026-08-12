import { readFileSync } from 'fs';
import { GoogleAuth } from 'google-auth-library';

const PROJECT = 'locarpayapp';
const BUCKET  = 'locarpayapp.appspot.com';

const NEW_RULES = readFileSync('./storage.rules', 'utf8');

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
const auth = new GoogleAuth({
  credentials: sa,
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

async function main() {
  const client = await auth.getClient();
  const token  = (await client.getAccessToken()).token;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Create ruleset
  const rs = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ source: { files: [{ name: 'storage.rules', content: NEW_RULES }] } })
  }).then(r => r.json());

  if (!rs.name) { console.error('Ruleset failed:', JSON.stringify(rs)); process.exit(1); }
  console.log('Ruleset:', rs.name);

  // Try POST to create storage release
  const releaseName = `projects/${PROJECT}/releases/firebase.storage/${BUCKET}`;
  let res = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ name: releaseName, rulesetName: rs.name })
  }).then(r => r.json());

  if (res.rulesetName) { console.log('✅ Release criado:', res.name); return; }
  console.log('POST result:', JSON.stringify(res));

  // Try PATCH in case it exists under a slightly different name
  res = await fetch(`https://firebaserules.googleapis.com/v1/${releaseName}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ name: releaseName, rulesetName: rs.name })
  }).then(r => r.json());
  console.log('PATCH result:', JSON.stringify(res));
}

main().catch(e => console.error(e.message));
