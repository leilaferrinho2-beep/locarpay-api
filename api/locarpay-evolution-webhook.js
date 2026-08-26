// POST /api/locarpay-evolution-webhook
// Recebe eventos do Evolution API e atualiza status de leitura das mensagens no Firestore

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.LOCARPAY_SERVICE_ACCOUNT)) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    initFirebase();
    const db = getFirestore();
    const body = req.body;

    const event = body?.event || body?.type;
    console.log('[evo-webhook] event:', event, JSON.stringify(body).slice(0, 300));

    // Evento de atualização de status de mensagem (lida, entregue, etc.)
    if (event === 'messages.update' || event === 'message.update') {
      const updates = Array.isArray(body?.data) ? body.data : [body?.data].filter(Boolean);

      for (const upd of updates) {
        const status = upd?.status || upd?.update?.status;
        const remoteJid = upd?.key?.remoteJid || upd?.remoteJid || '';
        const fromMe = upd?.key?.fromMe ?? upd?.fromMe ?? false;

        // Só processa mensagens enviadas por nós (fromMe=true) que foram lidas pelo inquilino
        if (!fromMe) continue;
        if (status !== 'READ' && status !== 'read' && status !== 4) continue;

        // Extrai número de telefone do remoteJid (ex: "5511999999999@s.whatsapp.net")
        const phone = remoteJid.replace(/@.*/, '').replace(/\D/g, '');
        if (!phone) continue;

        console.log(`[evo-webhook] READ confirmado para phone=${phone}`);

        // Busca chamados com mensagens não lidas deste número
        const chamadosSnap = await db.collectionGroup('messages')
          .where('readByTenant', '==', false)
          .where('fromMe', '==', true)
          .get();

        const batch = db.batch();
        let updated = 0;

        for (const msgDoc of chamadosSnap.docs) {
          const msgData = msgDoc.data();
          const msgPhone = (msgData.tenantPhone || '').replace(/\D/g, '');
          if (msgPhone && msgPhone.endsWith(phone.slice(-8))) {
            batch.update(msgDoc.ref, { readByTenant: true, readAt: new Date().toISOString() });
            updated++;
          }
        }

        // Alternativa: busca por chamadoId se vier no payload
        const chamadoId = upd?.chamadoId || upd?.key?.id;
        if (chamadoId) {
          const msgSnap = await db.collectionGroup('messages')
            .where('waMessageId', '==', chamadoId)
            .get();
          msgSnap.docs.forEach(d => {
            batch.update(d.ref, { readByTenant: true, readAt: new Date().toISOString() });
            updated++;
          });
        }

        if (updated > 0) await batch.commit();
        console.log(`[evo-webhook] ${updated} mensagens marcadas como lidas`);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[evo-webhook] erro:', e.message);
    return res.status(200).json({ ok: true }); // sempre 200 para o Evolution não retentar
  }
}
