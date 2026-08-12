import { readFileSync } from 'fs';
import { GoogleAuth } from 'google-auth-library';
const PROJECT = 'locarpayapp';
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
const auth = new GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/firebase'] });
const client = await auth.getClient();
const token = (await client.getAccessToken()).token;
const h = { Authorization: `Bearer ${token}` };

// List all releases
const releases = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`, { headers: h }).then(r => r.json());
console.log('Releases:', JSON.stringify(releases.releases?.map(r => r.name), null, 2));

// List recent rulesets
const rulesets = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets?pageSize=5`, { headers: h }).then(r => r.json());
console.log('\nRulesets recentes:', rulesets.rulesets?.map(r => r.name + ' ' + r.createTime));
