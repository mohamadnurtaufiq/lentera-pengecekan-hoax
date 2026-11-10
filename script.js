const $ = (id) => document.getElementById(id);

// Kata-kata yang diabaikan
const STOP = new Set("yang di ke dari dan atau ini itu dengan untuk pada adalah akan telah sudah dalam juga tidak bisa ada oleh para tersebut bahwa sebagai jadi saat baru tahun pada sejak berita kabar sekarang kini masih the a of to in is on for and".split(" "));

const keywords = (t) => [...new Set(
  (t || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w))
)];

const findYears = (t) => new Set(((t || "").match(/\b(1[5-9]\d\d|20\d\d)\b/g) || []));

const fetchTimeout = (url, ms = 10000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).then(r => { clearTimeout(t); if (!r.ok) throw r.status; return r; });
};

const proxy = (url) => `/proxy?url=${encodeURIComponent(url)}`;

function parseRSS(xmlText, label) {
  const xml = new DOMParser().parseFromString(xmlText, "text/xml");
  return [...xml.querySelectorAll("item")].slice(0, 15).map(i => ({
    source: label,
    media: i.querySelector("source")?.textContent || "",
    date: i.querySelector("pubDate")?.textContent || "",
    title: i.querySelector("title")?.textContent || "",
    url: i.querySelector("link")?.textContent || "#",
  }));
}

// Media berita Indonesia yang terverifikasi Dewan Pers & dikenal akurat
const TRUSTED = ["liputan6.com", "kompas.com", "detik.com", "tempo.co", "antaranews.com",
  "cnnindonesia.com", "cnbcindonesia.com", "kumparan.com", "tirto.id", "republika.co.id", "metrotvnews.com", "bbc.com"];

// ===== Sumber pencarian =====
const SOURCES = {
  "Media Terpercaya": async (q) => {
    const site = TRUSTED.map(s => "site:" + s).join(" OR ");
    const rss = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} (${site})`)}&hl=id&gl=ID&ceid=ID:id`;
    return parseRSS(await (await fetchTimeout(proxy(rss))).text(), "Media Terpercaya")
      .map(a => ({ ...a, trusted: true, source: "📰 " + (a.media || "Media Terpercaya") }));
  },
  "Google News": async (q) => {
    const rss = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=id&gl=ID&ceid=ID:id`;
    return parseRSS(await (await fetchTimeout(proxy(rss))).text(), "Google News");
  },
  "Bing News": async (q) => {
    const rss = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=id`;
    return parseRSS(await (await fetchTimeout(proxy(rss))).text(), "Bing News");
  },
  "Bing Web": async (q) => {
    const rss = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&setlang=id&cc=ID`;
    return parseRSS(await (await fetchTimeout(proxy(rss))).text(), "Bing Web");
  },
  "GDELT": async (q) => {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=10`;
    const data = await (await fetchTimeout(proxy(url))).json();
    return (data.articles || []).map(a => ({ source: "GDELT", title: a.title, url: a.url }));
  },
  "Wikipedia": async (q) => {
    const cleanQ = keywords(q).filter(w => !/^\d+$/.test(w) && !["usia", "umur", "sekarang", "adalah", "apakah", "benar", "hoax", "fakta"].includes(w)).slice(0, 4).join(" ") || q;
    const searchWiki = async (term) => {
      const url = `https://id.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&origin=*&srlimit=4`;
      const data = await (await fetchTimeout(url)).json();
      return (data.query?.search || []).map(s => ({
        source: "Wikipedia",
        title: s.title + " — " + s.snippet.replace(/<[^>]+>/g, ""),
        url: "https://id.wikipedia.org/wiki/" + encodeURIComponent(s.title),
      }));
    };
    const res1 = await searchWiki(q);
    if (res1.length >= 2 || cleanQ === q) return res1;
    const res2 = await searchWiki(cleanQ);
    const seen = new Set(res1.map(r => r.url));
    return res1.concat(res2.filter(r => !seen.has(r.url)));
  },
  "TurnBackHoax": async (q) => {
    const rss = `https://turnbackhoax.id/?s=${encodeURIComponent(q)}&feed=rss2`;
    return parseRSS(await (await fetchTimeout(proxy(rss))).text(), "TurnBackHoax")
      .map(a => ({ ...a, isFactCheck: true }));
  },
};


// ===== Pencocokan =====
const isYear = (w) => /^(1[5-9]\d\d|20\d\d)$/.test(w);

// Kembalikan { score, conflict }
// conflict = topik sama tapi tahun di sumber BERBEDA (bantahan)
function matchScore(query, title) {
  const qWords = keywords(query).filter(w => !isYear(w));
  const tWords = new Set(keywords(title));
  if (!qWords.length) return { score: 0, conflict: false };
  const topic = qWords.filter(w => tWords.has(w)).length / qWords.length;

  const qY = findYears(query), tY = findYears(title);
  if (qY.size > 0) {
    if (tY.size > 0 && ![...qY].some(y => tY.has(y))) {
      return { score: 0, conflict: topic >= 0.75 };
    }
    if (tY.size === 0) return { score: topic * 0.5, conflict: false };
  }
  return { score: topic, conflict: false };
}

const HOAX_LABEL = /\[(salah|hoaks|hoax|keliru|disinformasi|misleading|false)\]|\b(hoaks|hoax|disinformasi|tidak benar)\b/i;

// ===== Upload & Pratinjau Gambar =====
let selectedImage = null; // { base64, mimeType, name, metaInfo }

async function inspectImageFile(file) {
  // Baca sebagian awal file biner untuk mendeteksi metadata EXIF / tanda generator AI
  const slice = await file.slice(0, 65536).arrayBuffer();
  const raw = new TextDecoder("latin1").decode(slice);
  const aiTags = ["Midjourney", "Stable Diffusion", "DALL-E", "ComfyUI", "Automatic1111", "Adobe Firefly", "Bing Image Creator", "SynthID", "C2PA", "ai_generated", "DreamStudio", "Flux"];
  const editTags = ["Adobe Photoshop", "GIMP", "Canva", "PicsArt", "CapCut", "Lightroom"];
  const camTags = ["Canon", "Nikon", "SONY", "Apple", "Samsung", "Xiaomi", "OPPO", "vivo", " Fujifilm"];

  const foundAI = aiTags.filter(t => new RegExp(t, "i").test(raw));
  const foundEdit = editTags.filter(t => new RegExp(t, "i").test(raw));
  const foundCam = camTags.filter(t => new RegExp(t, "i").test(raw));

  // Kompres / sesuaikan ukuran agar pengiriman cepat
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });

  const maxDim = 1280;
  let w = img.naturalWidth, h = img.naturalHeight;
  if (w > maxDim || h > maxDim) {
    if (w > h) { h = Math.round(h * (maxDim / w)); w = maxDim; }
    else { w = Math.round(w * (maxDim / h)); h = maxDim; }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const outUrl = canvas.toDataURL("image/jpeg", 0.88);

  const notes = [
    `Nama file: ${file.name}`,
    `Resolusi asli: ${img.naturalWidth}x${img.naturalHeight}px (${(file.size / 1024).toFixed(1)} KB)`,
  ];
  if (foundAI.length) notes.push(`TERDETEKSI METADATA GENERATOR AI: ${foundAI.join(", ")}`);
  if (foundEdit.length) notes.push(`Terdeteksi metadata aplikasi edit: ${foundEdit.join(", ")}`);
  if (foundCam.length) notes.push(`Terdeteksi metadata kamera: ${foundCam.join(", ")}`);

  return {
    base64: outUrl.split(",")[1],
    mimeType: "image/jpeg",
    previewUrl: dataUrl,
    name: file.name,
    infoText: `${img.naturalWidth}×${img.naturalHeight}px · ${(file.size / 1024).toFixed(1)} KB` +
      (foundAI.length ? ` · ⚠️ Metadata AI (${foundAI[0]})` : foundCam.length ? ` · 📷 ${foundCam[0]}` : ""),
    metaInfo: notes.join(" | "),
  };
}

async function handleImageSelect(file) {
  if (!file || !file.type.startsWith("image/")) return;
  selectedImage = await inspectImageFile(file);
  // Kosongkan kotak teks lama agar teks pencarian sebelumnya tidak tercampur dengan pengecekan foto baru
  $("newsInput").value = "";
  $("imagePreview").src = selectedImage.previewUrl;
  $("imageName").textContent = selectedImage.name;
  $("imageInfo").textContent = selectedImage.infoText;
  $("uploadPrompt").classList.add("hidden");
  $("imagePreviewBox").classList.remove("hidden");
}

function clearSelectedImage() {
  selectedImage = null;
  $("imageInput").value = "";
  $("imagePreview").src = "";
  $("imagePreviewBox").classList.add("hidden");
  $("uploadPrompt").classList.remove("hidden");
}

$("dropZone").addEventListener("click", (e) => {
  if (e.target.id === "removeImageBtn") return;
  $("imageInput").click();
});
$("imageInput").addEventListener("change", (e) => handleImageSelect(e.target.files[0]));
$("removeImageBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  clearSelectedImage();
});
$("dropZone").addEventListener("dragover", (e) => { e.preventDefault(); $("dropZone").classList.add("dragover"); });
$("dropZone").addEventListener("dragleave", () => $("dropZone").classList.remove("dragover"));
$("dropZone").addEventListener("drop", (e) => {
  e.preventDefault();
  $("dropZone").classList.remove("dragover");
  handleImageSelect(e.dataTransfer.files[0]);
});
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (item) handleImageSelect(item.getAsFile());
});

// ===== Submit =====
$("checkForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("newsInput").value.trim();
  if (!input && !selectedImage) {
    $("newsInput").focus();
    return;
  }

  $("checkBtn").disabled = true;
  $("result").classList.add("hidden");
  $("loading").classList.remove("hidden");

  // ===== MODE 1: CEK GAMBAR / FOTO HOAX & AI-GENERATED =====
  if (selectedImage) {
    let trustedNews = [], results = [], names = Object.keys(SOURCES);
    $("loadingText").textContent = "Menganalisis forensik gambar & deteksi AI...";

    const gem = await fetch("/gemini-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: selectedImage.base64,
        mimeType: selectedImage.mimeType,
        metaInfo: selectedImage.metaInfo,
      }),
    })
      .then(async (r) => {
        const raw = await r.text();
        const data = JSON.parse(raw);
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        return data;
      })
      .catch(err => ({ error: err.message }));

    // Jika di dalam gambar ada teks berita (extractedQuery), cari juga beritanya
    const searchQ = (gem.extractedQuery || "").trim();
    if (searchQ.length > 3) {
      $("loadingText").textContent = `Mencari berita terkait: "${searchQ}"...`;
      results = await Promise.allSettled(names.map(n => SOURCES[n](searchQ)));
      trustedNews = (results[0].status === "fulfilled" ? results[0].value : []).slice(0, 10);
    }

    const gemOk = !gem.error && gem.verdict;
    const aiProb = Math.max(0, Math.min(99, Number(gem.aiProbability) || 0));
    const isAI = Boolean(gem.isAI) || gem.verdict === "AI_GENERATED" || aiProb >= 55;
    // Aturan: Gambar buatan AI = HOAX. Foto asli (tidak menggunakan AI & bukan rekayasa) = BUKAN HOAX (FAKTA).
    const isFakta = gemOk && !isAI && gem.verdict === "FAKTA";
    const isUnk = !gemOk;

    const conf = Math.max(0, Math.min(99, Number(gem.confidence) || 75));
    const color = isFakta ? "#10b981" : isUnk ? "#f59e0b" : "#ef4444";
    const cls = isFakta ? "fakta" : isUnk ? "" : "hoax";
    const title = isUnk
      ? "BELUM DAPAT DIPASTIKAN"
      : isFakta
      ? "BUKAN HOAX (FOTO ASLI / BUKAN AI)"
      : isAI
      ? "TERINDIKASI HOAX (GAMBAR BUATAN AI)"
      : "TERINDIKASI HOAX (FOTO REKAYASA / PALSU)";
    const icon = isFakta ? "✅" : isUnk ? "❔" : "❌";

    const indicators = Array.isArray(gem.visualIndicators) && gem.visualIndicators.length
      ? `<div class="forensic-box">
          <h4>🔬 Temuan Analisis Visual & Forensik Gambar:</h4>
          <ul>${gem.visualIndicators.map(item => `<li>${item}</li>`).join("")}</ul>
        </div>`
      : "";

    $("verdict").className = "card verdict " + cls;
    $("verdict").innerHTML = `
      <div class="icon">${icon}</div>
      <h2 style="color:${color}">${title}</h2>
      <p>${gemOk ? `🤖 <b>Analisis Forensik & AI</b>: ${gem.explanation || ""}` : `<small style="color:#f87171">⚠️ Gagal menganalisis gambar: ${gem.error}</small>`}</p>
      ${isUnk ? "" : `
        <div class="meter"><div style="width:${conf}%;background:${color}"></div></div>
        <small>Tingkat keyakinan: <b>${conf}%</b> · Skor kemungkinan buatan AI: <b>${aiProb}%</b></small>
      `}
      ${indicators}`;

    const seen = new Set();
    const newsList = results.flatMap(r => r.status === "fulfilled" ? r.value : [])
      .filter(a => a.title && !seen.has(a.title) && seen.add(a.title))
      .slice(0, 8);
    const allSources = newsList.concat((gem.sources || []).map(s => ({ ...s, source: "Gemini · Google Search" })));

    $("sources").innerHTML = allSources.slice(0, 10).map(a => `
      <a class="src" href="${a.url}" target="_blank" rel="noopener">
        <span class="tag">${a.isFactCheck ? "🚫 Cek Fakta · " : ""}${a.source}</span>
        <h4>${a.title}</h4>
      </a>`).join("");

    const enc = encodeURIComponent(searchQ || "cek fakta foto hoax");
    $("manualLinks").innerHTML = [
      ["📷 Google Lens (Cek Sumber Foto)", `https://lens.google.com/`],
      ["🔍 TinEye Reverse Image", `https://tineye.com/`],
      ["🤖 Sightengine AI Detector", `https://sightengine.com/detect-ai-generated-images`],
      ["🔬 FotoForensics (Cek Editan)", `https://fotoforensics.com/`],
      ["TurnBackHoax", `https://turnbackhoax.id/?s=${enc}`],
    ].map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${n} ↗</a>`).join("");

    $("result").classList.remove("hidden");
    $("loading").classList.add("hidden");
    $("checkBtn").disabled = false;
    return;
  }

  // ===== MODE 2: CEK TEKS BERITA =====

  const query = input.split(/[.!?\n]/).map(s => s.trim()).find(s => s.split(/\s+/).length >= 3) || input;
  const names = Object.keys(SOURCES);
  $("loadingText").textContent = "Mencari di media berita terpercaya...";
  const results = await Promise.allSettled(names.map(n => SOURCES[n](query)));

  // Gabungkan referensi dari Media Terpercaya, Wikipedia, Google News, & TurnBackHoax untuk dikirim ke Gemini
  const trustedNews = (results[0].status === "fulfilled" ? results[0].value : []).slice(0, 10);
  const gNews = (results[1].status === "fulfilled" ? results[1].value : []).slice(0, 5);
  const wikiList = (results[5].status === "fulfilled" ? results[5].value : []).slice(0, 4);
  const tbhList = (results[6].status === "fulfilled" ? results[6].value : []).slice(0, 4);

  const ctxLines = [
    ...wikiList.map(w => `- [Wikipedia] ${w.title}`),
    ...trustedNews.map(a => `- [${a.media || "Media Terpercaya"}] ${a.title} (${(a.date || "").slice(5, 16)})`),
    ...gNews.map(a => `- [Google News: ${a.media || ""}] ${a.title} (${(a.date || "").slice(5, 16)})`),
    ...tbhList.map(a => `- [TurnBackHoax Cek Fakta] ${a.title}`),
  ];
  const ctx = ctxLines.join("\n");
  $("loadingText").textContent = "Gemini AI menganalisis berita & fakta...";

  const gem = await fetch(
    `/gemini?q=${encodeURIComponent(input)}&ctx=${encodeURIComponent(ctx)}`
  )
    .then(async (r) => {
      const raw = await r.text();

      try {
        const data = JSON.parse(raw);

        if (!r.ok) {
          throw new Error(data.error || `HTTP ${r.status}`);
        }

        return data;
      } catch (e) {
        throw new Error(
          `Respons server bukan JSON. HTTP ${r.status}: ${raw.slice(0, 150)}`
        );
      }
    })
    .catch(e => ({ error: e.message }));
  const gemOk = !gem.error && gem.verdict;

  const status = names.map((n, i) => ({
    name: n, ok: results[i].status === "fulfilled", count: results[i].value?.length || 0,
  }));
  status.unshift({ name: "Gemini AI", ok: gemOk, count: gem.sources?.length || 0 });

  const seen = new Set();
  const scored = results.flatMap(r => r.status === "fulfilled" ? r.value : [])
    .filter(a => a.title && !seen.has(a.title) && seen.add(a.title))
    .map(a => ({ ...a, ...matchScore(query, a.title) }));

  const conflicting = scored.filter(a => a.conflict);
  // Klaim pendek: SEMUA kata kunci harus ada (1 kata beda bisa mengubah makna)
  const minScore = keywords(query).filter(w => !isYear(w)).length <= 5 ? 1 : 0.6;
  const all = scored.filter(a => a.score >= minScore).sort((a, b) => b.score - a.score);

  const debunked = all.filter(a => a.isFactCheck || HOAX_LABEL.test(a.title));
  const supporting = all.filter(a => !a.isFactCheck && !HOAX_LABEL.test(a.title));

  let verdict, msg, conf, list;
  if (conflicting.length > supporting.length) {
    verdict = "hoax"; list = conflicting;
    const yrs = [...new Set(conflicting.flatMap(a => [...findYears(a.title)]))].slice(0, 3).join(", ");
    msg = `<b>${conflicting.length}</b> sumber membahas topik yang sama tetapi dengan tahun berbeda (<b>${yrs}</b>). Klaim ini kemungkinan <b>SALAH</b>.`;
    conf = Math.min(95, 60 + conflicting.length * 5);
  } else if (debunked.length > 0) {
    verdict = "hoax"; list = debunked;
    msg = `Ditemukan <b>${debunked.length}</b> artikel cek fakta yang menyatakan berita ini <b>HOAKS</b>.`;
    conf = Math.min(95, 70 + debunked.length * 5);
  } else if (supporting.length > 0) {
    verdict = "fakta"; list = supporting;
    msg = `Berita ini ditemukan di <b>${supporting.length}</b> sumber. Lihat daftar berita di bawah.`;
    conf = Math.min(95, 50 + supporting.length * 7);
  } else {
    verdict = "unknown";
    list = [];
    msg = "Berita ini belum dapat dipastikan karena tidak ditemukan bukti yang cukup dari sumber terpercaya.";
    conf = 0;
  }

  // Gemini menilai berdasarkan berita media terpercaya & Wikipedia
  if (gemOk) {
    verdict = gem.verdict === "FAKTA" ? "fakta" : "hoax";
    conf = Math.max(0, Math.min(99, Number(gem.confidence) || 70));
    msg = `🤖 <b>Gemini AI</b> (berdasarkan ${trustedNews.length} berita media terpercaya & ${wikiList.length} data Wikipedia): ${gem.explanation || ""}`;
    const rel = [...wikiList, ...trustedNews].map(a => ({ ...a, ...matchScore(query, a.title) })).sort((a, b) => b.score - a.score);
    list = rel.concat((gem.sources || []).map(s => ({ ...s, source: "Gemini · Google Search" })));
  } else {
    msg += `<br><small style="color:#f87171">⚠️ Gemini gagal: ${gem.error || "tidak ada jawaban"}</small>`;
  }

  const isFakta = verdict === "fakta", isUnk = verdict === "unknown";
  const color = isFakta ? "#10b981" : isUnk ? "#f59e0b" : "#ef4444";
  $("verdict").className = "card verdict " + (isUnk ? "" : verdict);
  $("verdict").innerHTML = `
    <div class="icon">${isFakta ? "✅" : isUnk ? "❔" : "❌"}</div>
    <h2 style="color:${color}">${isFakta ? "BUKAN HOAX" : isUnk ? "BELUM DAPAT DIPASTIKAN" : "TERINDIKASI HOAX"}</h2>
    <p>${msg}</p>
    ${isUnk ? "" : `<div class="meter"><div style="width:${conf}%;background:${color}"></div></div>
    <small>Tingkat keyakinan: ${conf}%</small>`}
    <p style="margin-top:12px;font-size:.8rem;opacity:.7">
      Sumber dicek: ${status.map(s => `${s.ok ? "🟢" : "🔴"} ${s.name} (${s.count})`).join(" · ")}
    </p>`;

  $("sources").innerHTML = list.slice(0, 10).map(a => `
    <a class="src" href="${a.url}" target="_blank" rel="noopener">
      <span class="tag">${a.isFactCheck ? "🚫 Cek Fakta · " : ""}${a.source}</span>
      <h4>${a.title}</h4>
    </a>`).join("");

  const enc = encodeURIComponent(input);
  $("manualLinks").innerHTML = [
    ["🔍 Google", `https://www.google.com/search?q=${enc}`],
    ["TurnBackHoax", `https://turnbackhoax.id/?s=${enc}`],
    ["CekFakta.com", `https://cekfakta.com/search?q=${enc}`],
    ["Komdigi Hoaks", `https://www.komdigi.go.id/berita/berita-hoaks`],
  ].map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${n} ↗</a>`).join("");

  $("result").classList.remove("hidden");
  $("loading").classList.add("hidden");
  $("checkBtn").disabled = false;
});
