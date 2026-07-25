// POST /api/locarpay-set-owner-signed  { contractId }
// Define ownerSigned = true no Firestore para o contrato indicado

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contractId, completed } = req.body || {};
  if (!contractId) return res.status(400).json({ error: 'contractId obrigatório' });

  try {
    const fields = { ownerSigned: { booleanValue: true } };
    if (completed) fields.assinafyStatus = { stringValue: 'completed' };
    const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
    const r = await fetch(
      `${FS_BASE}/contracts/${contractId}?key=${FB_API_KEY}&${mask}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      }
    );
    if (!r.ok) throw new Error(await r.text());
    return res.status(200).json({ ok: true, contractId, fields: Object.keys(fields) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
