import { readFileSync } from 'fs';
import { GoogleAuth } from 'google-auth-library';
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
const auth = new GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();
const token = (await client.getAccessToken()).token;
console.log(token);
