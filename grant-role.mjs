import { readFileSync } from 'fs';
import { GoogleAuth } from 'google-auth-library';

const PROJECT = 'locarpayapp';
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
const SA_EMAIL = sa.client_email;
const ROLE = 'roles/firebaserules.admin';

const auth = new GoogleAuth({
  credentials: sa,
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

async function main() {
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // GET current IAM policy
  const getRes = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`,
    { method: 'POST', headers: h, body: JSON.stringify({}) }
  ).then(r => r.json());

  if (getRes.error) { console.error('getIamPolicy:', JSON.stringify(getRes.error)); process.exit(1); }
  console.log('IAM policy obtida, bindings:', getRes.bindings?.length);

  // Add binding
  const member = `serviceAccount:${SA_EMAIL}`;
  const existing = getRes.bindings?.find(b => b.role === ROLE);
  if (existing) {
    if (existing.members.includes(member)) { console.log('Role já concedido!'); process.exit(0); }
    existing.members.push(member);
  } else {
    getRes.bindings = getRes.bindings || [];
    getRes.bindings.push({ role: ROLE, members: [member] });
  }

  // SET policy
  const setRes = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:setIamPolicy`,
    { method: 'POST', headers: h, body: JSON.stringify({ policy: getRes }) }
  ).then(r => r.json());

  if (setRes.error) { console.error('setIamPolicy:', JSON.stringify(setRes.error)); process.exit(1); }
  console.log('✅ Role concedido:', ROLE, 'para', SA_EMAIL);
}

main().catch(e => console.error(e.message));
