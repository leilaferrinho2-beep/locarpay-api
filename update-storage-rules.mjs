import { readFileSync } from 'fs';
import { GoogleAuth } from 'google-auth-library';

const PROJECT = 'transgu-web-6d50f';
const BUCKET  = 'transgu-web-6d50f.firebasestorage.app';

const NEW_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {

    match /receipts/{userId}/{chargeId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == userId
        && request.resource.size < 10 * 1024 * 1024
        && request.resource.contentType.matches('image/.*');
    }

    match /leads/{ownerId}/{fileName} {
      allow read: if true;
      allow write: if request.auth != null
        && request.resource.size < 20 * 1024 * 1024
        && (request.resource.contentType.matches('image/.*')
            || request.resource.contentType == 'application/pdf');
    }

    match /signed_contracts/{contractId} {
      allow read: if true;
      allow write: if false;
    }

    match /chat/{chatId}/{fileName} {
      allow read: if true;
      allow write: if false;
    }

    match /download/{fileName} {
      allow read: if true;
      allow write: if false;
    }
  }
}`;

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/transgu-web-6d50f-firebase-adminsdk-fbsvc-1ad5f843f0.json', 'utf8'));
const auth = new GoogleAuth({
  credentials: sa,
  scopes: ['https://www.googleapis.com/auth/firebase', 'https://www.googleapis.com/auth/cloud-platform']
});

async function main() {
  const client = await auth.getClient();
  const token  = (await client.getAccessToken()).token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Cria novo ruleset
  const createRes = await fetch(
    `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { files: [{ name: 'storage.rules', content: NEW_RULES }] } })
    }
  );
  const ruleset = await createRes.json();
  if (!ruleset.name) { console.error('Falha ao criar ruleset:', JSON.stringify(ruleset)); process.exit(1); }
  console.log('Ruleset criado:', ruleset.name);

  // Tenta os dois nomes de release possíveis
  const releaseNames = [
    `firebase.storage`,
    `firebase.storage/${BUCKET}`,
  ];

  for (const relName of releaseNames) {
    const fullRelName = `projects/${PROJECT}/releases/${relName}`;

    // Tenta PATCH primeiro
    let res = await fetch(
      `https://firebaserules.googleapis.com/v1/${fullRelName}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: fullRelName, rulesetName: ruleset.name })
      }
    );
    let data = await res.json();
    if (data.rulesetName) { console.log(`✅ PATCH ${relName} OK — ${data.rulesetName}`); continue; }

    // Se PATCH falhou (404), cria com POST
    res = await fetch(
      `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: fullRelName, rulesetName: ruleset.name })
      }
    );
    data = await res.json();
    if (data.rulesetName) console.log(`✅ POST ${relName} OK — ${data.rulesetName}`);
    else console.log(`❌ ${relName}:`, JSON.stringify(data).slice(0, 200));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
