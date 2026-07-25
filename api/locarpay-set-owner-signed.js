// POST /api/locarpay-set-owner-signed  { contractId }
// Define ownerSigned = true no Firestore para o contrato indicado

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contractId } = req.body || {};
  if (!contractId) return res.status(400).json({ error: 'contractId obrigatório' });

  try {
    const r = await fetch(
      `${FS_BASE}/contracts/${contractId}?key=${FB_API_KEY}&updateMask.fieldPaths=ownerSigned`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { ownerSigned: { booleanValue: true } } })
      }
    );
    if (!r.ok) throw new Error(await r.text());
    return res.status(200).json({ ok: true, contractId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
