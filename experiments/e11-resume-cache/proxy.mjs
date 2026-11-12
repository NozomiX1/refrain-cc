// Pass-through to the Anthropic API that keeps each /v1/messages request body, to compare what CC sends (e11).
// usage: node proxy.mjs <port> <dir>
import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
const [port, dir] = process.argv.slice(2);
let n = 0;
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens"))
      writeFileSync(`${dir}/${String(++n).padStart(3, "0")}.json`, body);
    const up = https.request({ host: "api.anthropic.com", path: req.url, method: req.method, headers: { ...req.headers, host: "api.anthropic.com" } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    up.end(body);
  });
}).listen(Number(port), "127.0.0.1");
