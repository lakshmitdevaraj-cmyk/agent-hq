// What does Workers do with the one production use of node:https (HEAD with rejectUnauthorized:false)?
// badssl.com is a public site made for certificate tests. Run: wrangler dev -c probe/wrangler.jsonc
import https from "node:https";
const tryHost = (host) => new Promise((resolve) => {
  try {
    const req = https.request({ host, port: 443, path: "/", method: "HEAD", rejectUnauthorized: false, timeout: 8000 }, (res) => { res.resume(); resolve({ host, status: res.statusCode }); });
    req.on("error", (e) => resolve({ host, error: String(e.message).slice(0, 160) }));
    req.on("timeout", () => { req.destroy(); resolve({ host, error: "timeout" }); });
    req.end();
  } catch (e) {
    resolve({ host, threw: String(e.message).slice(0, 160) });
  }
});
export default { async fetch() { return Response.json(await Promise.all(["badssl.com", "self-signed.badssl.com", "expired.badssl.com"].map(tryHost))); } };
