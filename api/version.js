export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    versionCode: 46,
    versionName: "3.24",
    url: "https://locarpay-api.vercel.app/download/locarpay-v46.apk"
  });
}
