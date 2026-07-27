export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 73,
    versionName: "3.51",
    url: "https://github.com/leilaferrinho2-beep/locarpay-api/releases/download/v3.51/locarpay-v73.apk"
  });
}
