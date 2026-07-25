// POST /api/locarpay-assinafy-webhook
// Recebe eventos da Assinafy quando um signatário assina ou o documento é concluído.
// Atualiza ownerSigned e assinafyStatus no Firestore automaticamente.

const FB_PROJECT = 'locarpayapp';
const FB_API_KEY = process.env.LOCARPAY_FIREBASE_API_KEY;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

async function fsQuery(collectionId, field, value) {
  const r = await fetch(`${FS_BASE}:runQuery?key=${FB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op: 'EQUAL',
            value: { stringValue: value }
          }
        },
        limit: 1
      }
    })
  });
  if (!r.ok) throw new Error(`Firestore query: ${r.status}`);
  const rows = await r.json();
  return rows.find(row => row.document)?.document || null;
}

async function fsPatch(path, fields) {
  const updateMask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?key=${FB_API_KEY}&${updateMask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${path}: ${await r.text()}`);
  return r.json();
}

function extractDocumentId(payload) {
  // Assinafy pode enviar o documentId em diferentes formatos dependendo do evento
  return (
    payload?.data?.document?.id ||
    payload?.document?.id ||
    payload?.document_id ||
    payload?.data?.document_id ||
    null
  );
}

function extractEvent(payload) {
  return (
    payload?.event ||
    payload?.type ||
    payload?.data?.event ||
    ''
  ).toLowerCase();
}

function extractSignerStep(payload) {
  const signer =
    payload?.data?.signer ||
    payload?.signer ||
    null;
  return signer?.step ?? signer?.order ?? null;
}

function isFullySigned(event) {
  // document_ready = último signatário assinou (Assinafy)
  return ['document_ready', 'document_completed', 'assignment.completed', 'completed', 'finished'].some(e => event.includes(e));
}

function isSignerRequested(event) {
  // signature_requested dispara quando um signatário é solicitado.
  // No fluxo step-based: dispara para step 1 (início) e step 2 (após proprietário assinar).
  // Só nos interessa quando step >= 2 (inquilino sendo solicitado = proprietário já assinou).
  return event === 'signature_requested';
}

export default async function handler(req, res) {
  // Assinafy faz POST; aceita também GET para verificar se o endpoint está vivo
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'locarpay-assinafy-webhook' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};

  // Log completo para diagnóstico inicial
  console.log('[assinafy-webhook] payload:', JSON.stringify(payload));

  const event = extractEvent(payload);
  const documentId = extractDocumentId(payload);

  if (!documentId) {
    console.warn('[assinafy-webhook] documentId ausente no payload');
    // Retorna 200 para Assinafy não retentar (payload não reconhecido)
    return res.status(200).json({ ok: true, skipped: 'documentId não encontrado no payload' });
  }

  try {
    // Busca o contrato no Firestore pelo assinafyDocumentId
    const contractDoc = await fsQuery('contracts', 'assinafyDocumentId', documentId);

    if (!contractDoc) {
      console.warn(`[assinafy-webhook] contrato não encontrado para documentId=${documentId}`);
      return res.status(200).json({ ok: true, skipped: 'contrato não encontrado' });
    }

    // Extrai o ID do documento do Firestore (formato: projects/.../documents/contracts/{id})
    const contractFirestoreId = contractDoc.name.split('/').pop();

    const updates = {};

    if (isFullySigned(event)) {
      // Todos assinaram — contrato concluído
      updates.assinafyStatus = { stringValue: 'completed' };
      updates.ownerSigned = { booleanValue: true };
      console.log(`[assinafy-webhook] contrato ${contractFirestoreId} concluído`);
    } else if (isSignerRequested(event)) {
      const step = extractSignerStep(payload);
      // signature_requested com step=2 significa que o inquilino foi solicitado a assinar,
      // ou seja, o proprietário (step 1) já assinou.
      // Se step for null/desconhecido, logamos mas não atualizamos (aguarda payload real).
      if (step !== null && step >= 2) {
        updates.ownerSigned = { booleanValue: true };
        console.log(`[assinafy-webhook] proprietário assinou, inquilino solicitado (step=${step}) — contrato ${contractFirestoreId}`);
      } else {
        console.log(`[assinafy-webhook] signature_requested step=${step} — aguardando step>=2 para marcar ownerSigned`);
      }
    } else {
      console.log(`[assinafy-webhook] evento '${event}' não mapeado — nenhuma ação`);
      return res.status(200).json({ ok: true, skipped: `evento '${event}' não mapeado` });
    }

    if (Object.keys(updates).length > 0) {
      await fsPatch(`contracts/${contractFirestoreId}`, updates);
    }

    return res.status(200).json({ ok: true, contractId: contractFirestoreId, updates: Object.keys(updates) });
  } catch (e) {
    console.error('[assinafy-webhook] erro:', e.message);
    // Retorna 500 para Assinafy retentar
    return res.status(500).json({ error: e.message });
  }
}
