// Server lokal: menampilkan website + proxy untuk mengambil berita (mengatasi CORS)
// Jalankan: node server.js  lalu buka http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const ALLOWED = /(^|\.)(google\.com|bing\.com|turnbackhoax\.id|gdeltproject\.org|wikipedia\.org)$/;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // Gemini + Google Search (mirip "Ringkasan AI" Google)
  if (u.pathname === "/gemini") {
    res.setHeader("Content-Type", "application/json");
    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.writeHead(500); return res.end(JSON.stringify({ error: "GEMINI_API_KEY belum diset" })); }
    try {
      const claim = u.searchParams.get("q") || "";
      const prompt = `Kamu adalah pemeriksa fakta. Cari di Google lalu nilai klaim berikut:\n"${claim}"\n\n` +
        `Balas HANYA JSON tanpa markdown dengan format:\n` +
        `{"verdict":"FAKTA"|"HOAX"|"TIDAK PASTI","confidence":0-100,"explanation":"penjelasan singkat bahasa Indonesia, maks 3 kalimat"}`;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || r.status);
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
      const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
      const sources = (cand?.groundingMetadata?.groundingChunks || [])
        .filter(c => c.web).map(c => ({ title: c.web.title, url: c.web.uri }));
      res.end(JSON.stringify({ ...json, sources }));
    } catch (e) {
      res.writeHead(502); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (u.pathname === "/proxy") {
    try {
      const target = new URL(u.searchParams.get("url"));
      if (!ALLOWED.test(target.hostname)) throw new Error("host tidak diizinkan");
      const r = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36", "Accept-Language": "id-ID,id;q=0.9" },
        signal: AbortSignal.timeout(10000),
      });
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "text/plain", "Access-Control-Allow-Origin": "*" });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502); res.end("proxy error: " + e.message);
    }
    return;
  }

  const file = path.join(__dirname, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`✅ Buka http://localhost:${PORT}`));
