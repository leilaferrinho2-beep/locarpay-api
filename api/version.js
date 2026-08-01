export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    versionCode: 121,
    versionName: "4.1",
    url: "https://ilocarpay.com.br/download/locarpay-v121.apk"
  });
}
