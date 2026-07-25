export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 35,
    versionName: "3.13",
    url: "https://locarpay-api.vercel.app/download/locarpay.apk"
  });
}
