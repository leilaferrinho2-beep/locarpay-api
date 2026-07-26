/**
 * POST /api/locarpay-terms
 *
 * Rotas:
 *   step: "check"  → verifica se o usuário já aceitou a versão corrente
 *   step: "accept" → grava aceite + log de auditoria LGPD
 *
 * Este endpoint usa withAuth(handler, false) — verifica o token mas NÃO
 * exige aceite prévio (pois é justamente o endpoint para aceitar).
 */

import {
  withAuth,
  recordTermsAcceptance,
  CURRENT_TERMS_VERSION
} from './lib/authMiddleware.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

// Texto canônico dos termos — o SHA-256 deste texto é gravado no log de auditoria.
// Mantenha sincronizado com o texto exibido no app.
const TERMS_TEXT = `
TERMOS DE USO E POLÍTICA DE PRIVACIDADE — LocarPay (versão 2025-01)

1. OBJETO
O aplicativo LocarPay intermediates a gestão de contratos de locação residencial
entre proprietários e inquilinos, incluindo emissão de cobranças, recebimento via
PIX e cartão de crédito, assinatura eletrônica de contratos e comunicação entre
as partes.

2. DADOS COLETADOS (LGPD — Lei 13.709/2018)
Coletamos nome completo, CPF, e-mail, telefone, endereço e dados de pagamento
estritamente para execução do contrato de locação. Não compartilhamos dados
com terceiros sem consentimento, salvo obrigação legal.

3. PAGAMENTOS
Pagamentos via cartão de crédito estão sujeitos à taxa de 2,99% + R$0,49,
repassada integralmente ao inquilino conforme cláusula 4.2 do contrato.
Pagamentos via PIX são gratuitos.

4. COMUNICAÇÕES
Ao aceitar estes termos você autoriza o recebimento de notificações sobre
vencimentos, confirmações de pagamento e avisos do proprietário pelo aplicativo,
e-mail e WhatsApp cadastrado.

5. RETENÇÃO E EXCLUSÃO DE DADOS
Os dados são retidos pelo prazo legal de 5 anos após o encerramento do contrato.
Após este prazo serão anonimizados. Você pode solicitar a exclusão antecipada
pelo e-mail contatotransgu@gmail.com, sujeito às obrigações legais vigentes.

6. FORO
Fica eleito o foro da comarca do imóvel locado para dirimir quaisquer controvérsias.
`;

function getDb() {
  if (getApps().length === 0) {
    const sa = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    );
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { step } = req.body || {};

  // ── check: retorna se o usuário já aceitou e qual versão ─────────────────
  if (step === 'check') {
    const db   = getDb();
    const snap = await db.collection('users').doc(req.uid).get();
    const data = snap.exists ? snap.data() : {};
    return res.status(200).json({
      accepted:        data.acceptedTermsVersion === CURRENT_TERMS_VERSION,
      currentVersion:  CURRENT_TERMS_VERSION,
      acceptedVersion: data.acceptedTermsVersion || null,
      acceptedAt:      data.termsAcceptedAt?.toDate?.()?.toISOString() || null
    });
  }

  // ── accept: grava aceite + auditoria ─────────────────────────────────────
  if (step === 'accept') {
    await recordTermsAcceptance(req.uid, req.email, req, TERMS_TEXT);
    return res.status(200).json({
      ok:      true,
      version: CURRENT_TERMS_VERSION
    });
  }

  return res.status(400).json({ error: 'step inválido' });
}

// false = não exige aceite prévio (é o próprio endpoint de aceite)
export default withAuth(handler, false);
