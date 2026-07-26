export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 61,
    versionName: "3.39",
    url: "https://github.com/leilaferrinho2-beep/locarpay-api/releases/download/v3.39/locarpay-v61.apk"
  });
}
