export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 54,
    versionName: "3.32",
    url: "https://github.com/leilaferrinho2-beep/locarpay-api/releases/download/v3.32/locarpay-v54.apk"
  });
}
