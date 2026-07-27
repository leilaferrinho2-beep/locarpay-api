export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 71,
    versionName: "3.49",
    url: "https://github.com/leilaferrinho2-beep/locarpay-api/releases/download/v3.49/locarpay-v71.apk"
  });
}
