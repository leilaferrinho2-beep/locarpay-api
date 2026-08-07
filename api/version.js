// GET /api/version — retorna versão mais recente do app para o mecanismo de atualização
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    versionCode: 136,
    versionName: '4.16',
    url: 'https://www.ilocarpay.com.br/download/locarpay-v82.apk'
  });
}
