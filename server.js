// Server lokal: menampilkan website + proxy untuk mengambil berita (mengatasi CORS)
// Jalankan: node server.js  lalu buka http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

// Baca API key dari file .env (jika ada)
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2].trim();
  });
} catch {}

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
      const ctx = (u.searchParams.get("ctx") || "").slice(0, 3000);
      const prompt = `Kamu adalah pemeriksa fakta. Hari ini ${new Date().toLocaleDateString("id-ID", { dateStyle: "long" })}.\n` +
        `Klaim: "${claim}"\n\n` +
        (ctx ? `Judul berita dari media terpercaya (Liputan6, Kompas, Detik, Tempo, Antara, dll):\n${ctx}\n\n` +
          `Gunakan judul-judul berita di atas sebagai BUKTI UTAMA. Jika berita mendukung klaim → FAKTA. Jika bertentangan → HOAX.\n`
          : `Tidak ada berita dari media terpercaya yang ditemukan. Nilai dengan pengetahuanmu.\n`) +
        `Wajib pilih salah satu: FAKTA jika klaim benar, HOAX jika klaim salah/tidak terbukti.\n` +
        `Balas HANYA JSON tanpa markdown dengan format:\n` +
        `{"verdict":"FAKTA"|"HOAX","confidence":0-100,"explanation":"penjelasan singkat bahasa Indonesia, sebut nama media yang memberitakan, maks 3 kalimat"}`;
      const call = (model, withSearch) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], ...(withSearch ? { tools: [{ google_search: {} }] } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      // Coba bergantian: kuota habis (429) / model penuh (503) → lanjut ke berikutnya
      const attempts = [
        ["gemini-flash-latest", true], ["gemini-flash-latest", false],
        ["gemini-3.5-flash", false], ["gemini-flash-lite-latest", false],
        ["gemini-3.1-flash-lite", false], ["gemini-2.5-flash", false],
      ];
      let r, data, lastErr = "semua model gagal";
      for (const [m, s] of attempts) {
        try {
          r = await call(m, s); data = await r.json();
          if (r.ok) break;
          lastErr = data.error?.message || r.status;
        } catch (e) { lastErr = e.message; }
        r = null;
      }
      if (!r) throw new Error(lastErr);
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
  if (!file.startsWith(__dirname) || path.basename(file).startsWith(".")) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`✅ Buka http://localhost:${PORT}`));
