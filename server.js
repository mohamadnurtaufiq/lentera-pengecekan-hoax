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

const handler = async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const ep = u.searchParams.get("__ep") || u.pathname.replace(/^\/+/, "");

  // Gemini + Google Search (mirip "Ringkasan AI" Google)
  if (ep === "gemini") {
    res.setHeader("Content-Type", "application/json");
    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.writeHead(500); return res.end(JSON.stringify({ error: "GEMINI_API_KEY belum diset" })); }
    try {
      const claim = u.searchParams.get("q") || "";
      const ctx = (u.searchParams.get("ctx") || "").slice(0, 3500);
      const now = new Date();
      const todayStr = now.toLocaleDateString("id-ID", { dateStyle: "full" });
      const curYear = now.getFullYear();
      const prompt = `Kamu adalah sistem pemeriksa fakta cerdas (seperti Ringkasan AI Google). Hari ini adalah ${todayStr} (Tahun ${curYear}).\n` +
        `Klaim yang diperiksa: "${claim}"\n\n` +
        (ctx ? `Referensi pendukung dari berita & Wikipedia:\n${ctx}\n\n` : "") +
        `Aturan Analisis Penting:\n` +
        `1. Gunakan pengetahuan faktual, sejarah, Wikipedia, hasil pencarian web, DAN referensi di atas secara cerdas.\n` +
        `2. PERHITUNGAN USIA / TAHUN: Ingat bahwa sekarang adalah tahun ${curYear}. Jika klaim menyebut usia/umur (misal klub, tokoh, organisasi, kemerdekaan), HITUNG selisih tahun berdirinya/lahirnya terhadap tahun ${curYear} (contoh: berdiri 2 November 1915, maka pada November ${curYear} usianya adalah ${curYear} - 1915 = ${curYear - 1915} tahun → FAKTA). Jangan terkecoh oleh judul berita tahun lama (2023/2024/2025) yang menyebut usia tahun sebelumnya!\n` +
        `3. Jangan menyatakan HOAX hanya karena judul berita di referensi tidak memuat kalimat persis dengan klaim. Jika secara fakta sejarah/data resmi klaim tersebut BENAR, wajib jawab FAKTA.\n` +
        `4. Pilih "FAKTA" jika klaim benar secara faktual, atau "HOAX" jika klaim terbukti salah/bohong.\n` +
        `Balas HANYA JSON murni tanpa markdown dengan format:\n` +
        `{"verdict":"FAKTA"|"HOAX","confidence":0-100,"explanation":"penjelasan singkat, akurat, dan jelas bahasa Indonesia (sebutkan tanggal berdiri/fakta atau media pendukung), maks 3 kalimat"}`;
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

  // Gemini Vision: Cek Gambar Hoax / Manipulasi / Buatan AI (AI-Generated)
  if (ep === "gemini-image" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.writeHead(500); return res.end(JSON.stringify({ error: "GEMINI_API_KEY belum diset di Environment Variables" })); }
    try {
      let parsedBody = req.body;
      if (!parsedBody || typeof parsedBody !== "object") {
        const bodyRaw = typeof parsedBody === "string" ? parsedBody : await new Promise((resolve, reject) => {
          let chunks = "", size = 0;
          req.on("data", c => {
            size += c.length;
            if (size > 12 * 1024 * 1024) { reject(new Error("Ukuran gambar terlalu besar (maks 10MB)")); req.destroy(); }
            else chunks += c;
          });
          req.on("end", () => resolve(chunks));
          req.on("error", reject);
        });
        parsedBody = JSON.parse(bodyRaw || "{}");
      }
      const { imageBase64, mimeType, metaInfo } = parsedBody;
      if (!imageBase64) throw new Error("Data gambar kosong");

      const prompt = `Kamu adalah ahli forensik digital dan detektor gambar AI (AI-generated image detector). Hari ini ${new Date().toLocaleDateString("id-ID", { dateStyle: "long" })}.\n` +
        (metaInfo ? `Metadata file gambar: ${metaInfo}\n` : "") +
        `\nTugas Utama:\n` +
        `Tentukan apakah foto/gambar ini adalah **FOTO ASLI (Kamera Nyata)** atau **GAMBAR BUATAN AI (AI-Generated) / REKAYASA HOAKS**.\n\n` +
        `Aturan Penting yang WAJIB Dipatuhi:\n` +
        `1. **FOTO PRIBADI / FOTO STUDIO / DOKUMENTASI NYATA = FAKTA (BUKAN HOAX)**:\n` +
        `   - Jika gambar adalah foto manusia asli (misalnya foto studio bersama teman/mahasiswa, foto memakai jas almamater, foto selfie, foto keluarga, pemandangan, atau objek nyata dari kamera/HP), meskipun menggunakan pencahayaan studio atau warna yang cerah/rapi, itu adalah **FOTO ASLI** → WAJIB beri \`"verdict": "FAKTA"\`, \`"isAI": false\`, dan \`"aiProbability"\` rendah (0-15).\n` +
        `   - Foto pribadi atau foto studio TIDAK PERLU ada di berita media untuk menjadi FAKTA.\n` +
        `2. **GAMBAR BUATAN AI (AI-GENERATED) = HOAX**:\n` +
        `   - Hanya nyatakan \`"isAI": true\` dan \`"verdict": "HOAX"\` jika terdapat bukti kuat gambar dibuat oleh AI generator (seperti kulit tampak seperti lukisan plastik/CGI 3D, jari tangan cacat/jumlah jari salah, teks latar belakang hancur/simbol alien, proporsi wajah/tubuh tidak masuk akal, atau ada watermark/metadata AI).\n` +
        `3. **SCREENSHOT BERITA PALSU / MEME HOAKS = HOAX**:\n` +
        `   - Jika gambar berupa tangkapan layar artikel/pesan berantai yang berisi klaim berita bohong atau tempelan manipulasi kasar untuk menipu publik → beri \`"verdict": "HOAX"\`, \`"isAI": false\`.\n` +
        `4. Isi \`"extractedQuery"\` HANYA jika di dalam gambar terdapat teks judul berita yang perlu dicek di media. Jika gambar adalah foto orang/studio/objek biasa tanpa teks berita, wajib isi \`"extractedQuery": ""\`.\n\n` +
        `Balas HANYA JSON murni tanpa markdown dengan format:\n` +
        `{"verdict":"FAKTA"|"HOAX","isAI":true|false,"confidence":0-100,"aiProbability":0-100,"extractedQuery":"","visualIndicators":["temuan visual 1 (misal: proporsi anatomi & jari tangan normal/alami)","temuan visual 2 (misal: pencahayaan studio & tekstur pakaian nyata)","temuan visual 3"],"explanation":"penjelasan jelas dalam bahasa Indonesia mengapa foto ini terdeteksi sebagai Foto Asli (Bukan AI) atau Gambar AI/Hoaks (maks 3 kalimat)"}`;

      const parts = [
        { text: prompt },
        { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } }
      ];
      const call = (model, withSearch) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts }], ...(withSearch ? { tools: [{ google_search: {} }] } : {}) }),
        signal: AbortSignal.timeout(25000),
      });
      const attempts = [
        ["gemini-flash-latest", true], ["gemini-flash-latest", false],
        ["gemini-2.5-flash", false], ["gemini-flash-lite-latest", false],
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

  if (ep === "proxy") {
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
};

module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => console.log(`✅ Buka http://localhost:${PORT}`));
}
