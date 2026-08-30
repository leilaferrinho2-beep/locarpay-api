const admin = require('firebase-admin');
const { readFileSync } = require('fs');
const sa = JSON.parse(readFileSync('C:/Users/denis/Downloads/locarpayapp-firebase-adminsdk-fbsvc-e92d24aa50.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  // Busca cobranças da Leila com description (avulsas) com status overdue mas vencendo hoje ou no futuro
  const snap = await db.collection('charges')
    .where('tenantEmail', 'in', ['leilamferrinho@outlook.com', 'leilaferrinho2@gmail.com'])
    .where('status', '==', 'overdue')
    .get();

  const hoje = new Date();
  const tzBR = 'America/Sao_Paulo';
  const hojeStr = hoje.toLocaleDateString('pt-BR', { timeZone: tzBR });

  let fixed = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const dueDate = d.dueDate?.toDate();
    if (!dueDate) continue;
    const dueStr = dueDate.toLocaleDateString('pt-BR', { timeZone: tzBR });
    console.log(`Cobrança ${doc.id}: due=${dueStr} hoje=${hojeStr} desc="${d.description||d.monthRef}"`);

    // Reseta para pending se vencimento >= hoje (no fuso Brasil)
    const dueDay = dueDate.toLocaleDateString('pt-BR', { timeZone: tzBR, day:'2-digit', month:'2-digit', year:'numeric' });
    const hojDay = hoje.toLocaleDateString('pt-BR', { timeZone: tzBR, day:'2-digit', month:'2-digit', year:'numeric' });
    if (dueStr >= hojeStr) {
      const baseRent = d.baseRent || 0;
      await doc.ref.update({
        status: 'pending',
        multaAplicada: 0,
        jurosAplicado: 0,
        ipcaAplicado: 0,
        diasAtraso: 0,
        totalAmount: baseRent,
      });
      console.log(`  ✅ Resetada para pending, totalAmount=${baseRent}`);
      fixed++;
    }
  }
  console.log(`\n${fixed} cobrança(s) corrigida(s).`);
  process.exit(0);
})();
