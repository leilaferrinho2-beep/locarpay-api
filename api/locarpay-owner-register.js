// POST /api/locarpay-owner-register
// Cadastra nova imobiliária/proprietário na plataforma LocarPay SaaS
// Body: { name, email, phone, cnpj?, plan? }
// Retorna: { ownerId, trialEndsAt }

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp }       from 'firebase-admin/firestore';

const PLANS = {
  trial: { maxTenants: 3,  maxProperties: 2,  monthlyPrice: 0   },
  basic: { maxTenants: 10, maxProperties: 5,  monthlyPrice: 49  },
  pro:   { maxTenants: 30, maxProperties: 20, monthlyPrice: 99  },
};

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();

    const { name, email, phone, cnpj, plan = 'trial', firebaseUid } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'name e email são obrigatórios' });

    // Verifica se email já cadastrado
    const existing = await db.collection('owners').where('email', '==', email).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ error: 'Email já cadastrado', ownerId: existing.docs[0].id });
    }

    const now = Timestamp.now();
    const trialEndsAt = Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 dias

    const planConfig = PLANS[plan] || PLANS.trial;

    // Se veio o firebaseUid (do Firebase Auth), usa como ID do documento
    // Assim owners/{uid} fica alinhado com o Auth UID
    const docRef = firebaseUid
      ? db.collection('owners').doc(firebaseUid)
      : db.collection('owners').doc();

    await docRef.set({
      name,
      email,
      phone:  phone  || '',
      cnpj:   cnpj   || '',
      plan,
      status: 'trial',
      maxTenants:    planConfig.maxTenants,
      maxProperties: planConfig.maxProperties,
      monthlyPrice:  planConfig.monthlyPrice,
      // Chaves Asaas/Assinafy preenchidas após criar subconta (Fase 2)
      asaasApiKey:       '',
      asaasSubaccountId: '',
      assinafyApiKey:    '',
      createdAt:     now,
      trialEndsAt,
      planActiveUntil: trialEndsAt,
    });

    return res.status(201).json({
      ownerId: docRef.id,
      trialEndsAt: trialEndsAt.toDate().toISOString(),
      plan,
      message: 'Owner cadastrado com sucesso. Trial de 14 dias ativo.',
    });

  } catch (e) {
    console.error('owner-register error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
