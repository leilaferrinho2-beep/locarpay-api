// Use firebase-tools programmatically with service account
process.env.GOOGLE_APPLICATION_CREDENTIALS = 'C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json';

const tools = require('C:/nvm4w/nodejs/node_modules/firebase-tools');

tools.deploy({
  project: 'locarpayapp',
  only: 'storage',
  cwd: 'C:/locarpay-api',
  token: undefined,
}).then(() => {
  console.log('✅ Storage rules deployed!');
}).catch(e => {
  console.error('Error:', e.message);
});
