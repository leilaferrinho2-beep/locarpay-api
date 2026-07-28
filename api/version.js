export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 78,
    versionName: "3.56",
    url: "https://github.com/leilaferrinho2-beep/locarpay-api/releases/download/v3.56/locarpay-v78.apk"
  });
}
