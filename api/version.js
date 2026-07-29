export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 94,
    versionName: "3.72",
    url: "https://locarpay-api.vercel.app/download/locarpay-v94.apk"
  });
}
