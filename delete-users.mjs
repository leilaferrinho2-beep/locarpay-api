import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'fs';

const sa = JSON.parse(readFileSync('C:\\locarpay-api\\locarpay-serviceaccount.json', 'utf8'));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });

const auth = getAuth();
const toDelete = [
  '0YG0fKe9k6Z4IBigCji1fzcJ61L2', // denisfelicio20@gmail.com
  'XvD1thhQdObUtdDG9SCroFNpsS42', // leilaferrinho2@gmail.com
];

const result = await auth.deleteUsers(toDelete);
console.log('Deletados:', result.successCount);
if (result.errors.length) console.error('Erros:', result.errors);
