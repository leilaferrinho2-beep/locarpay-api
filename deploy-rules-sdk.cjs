const admin = require('firebase-admin');
const { readFileSync } = require('fs');

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa), storageBucket: 'locarpayapp.appspot.com' });

const rulesContent = readFileSync('./storage.rules', 'utf8');

(async () => {
  try {
    const sr = admin.securityRules();
    // createRulesFileFromSource(name, content)
    const source = sr.createRulesFileFromSource('storage.rules', rulesContent);
    console.log('source:', source);
    // createRuleset then releaseStorageRuleset
    const ruleset = await sr.createRuleset(source);
    console.log('Ruleset:', ruleset.name);
    await sr.releaseStorageRuleset(ruleset);
    console.log('✅ Deployed!');
  } catch (e) {
    console.error('Erro:', e.errorInfo || e.message || e);
  }
})();
