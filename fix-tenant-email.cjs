// Script pontual: corrige users doc da inquilina (ownerId/active faltando)
// Uso: node fix-tenant-email.cjs <email-correto>
const admin = require('firebase-admin');
const { readFileSync } = require('fs');

const emailCorreto = process.argv[2]?.trim().toLowerCase();
if (!emailCorreto) { console.error('Uso: node fix-tenant-email.cjs <email>'); process.exit(1); }

const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  // 1. Busca users doc pelo email
  const existing = await db.collection('users').where('email', '==', emailCorreto).limit(1).get();
  let tenantId = null;
  let currentData = null;
  if (!existing.empty) {
    tenantId = existing.docs[0].id;
    currentData = existing.docs[0].data();
    console.log('users doc:', tenantId, '| ownerId:', currentData.ownerId || '(vazio)', '| active:', currentData.active);
  }

  // 2. Busca contrato para pegar ownerId e dados completos
  const contractSnap = await db.collection('contracts')
    .where('tenantEmail', '==', emailCorreto)
    .limit(1).get();

  let ownerId = currentData?.ownerId || null;
  let tenantName = currentData?.name || '';
  let tenantPhone = currentData?.phone || '';
  let tenantCpf = currentData?.cpf || '';

  if (!contractSnap.empty) {
    const c = contractSnap.docs[0].data();
    ownerId = ownerId || c.ownerId;
    tenantId = tenantId || c.tenantId;
    tenantName = tenantName || c.tenantName || '';
    tenantPhone = tenantPhone || c.tenantPhone || '';
    tenantCpf = tenantCpf || c.tenantCpf || '';
    console.log('Contrato encontrado. ownerId:', c.ownerId, '| tenantId:', c.tenantId);
  } else {
    // fallback: busca lead
    const leadSnap = await db.collection('leads')
      .where('tenantEmail', '==', emailCorreto).limit(1).get();
    if (!leadSnap.empty) {
      const l = leadSnap.docs[0].data();
      ownerId = ownerId || l.ownerId;
      tenantId = tenantId || l.tenantId;
      console.log('Lead encontrado. ownerId:', l.ownerId);
    }
  }

  if (!ownerId) { console.log('ownerId não encontrado. Informe manualmente.'); process.exit(1); }
  if (!tenantId) { console.log('tenantId não encontrado.'); process.exit(1); }

  // 3. Atualiza/cria users doc com dados completos
  await db.collection('users').doc(tenantId).set({
    email:    emailCorreto,
    ownerId,
    name:     tenantName,
    phone:    tenantPhone,
    cpf:      tenantCpf,
    role:     'tenant',
    active:   true,
    suspended: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  console.log('CORRIGIDO. users doc:', tenantId, '| ownerId:', ownerId, '| active: true');
  process.exit(0);
})();
