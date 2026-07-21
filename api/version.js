export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 18,
    versionName: "2.6",
    url: "https://locarpay-api.vercel.app/download/locarpay.apk"
  });
}
