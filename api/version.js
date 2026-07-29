export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 92,
    versionName: "3.70",
    url: "https://locarpay-api.vercel.app/download/locarpay-v92.apk"
  });
}
