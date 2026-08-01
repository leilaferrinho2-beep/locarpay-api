export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    versionCode: 120,
    versionName: "4.0",
    url: "https://ilocarpay.com.br/download/locarpay-v120.apk"
  });
}
