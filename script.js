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
    const url = `https://id.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&origin=*&srlimit=5`;
    const data = await (await fetchTimeout(url)).json();
    return data.query.search.map(s => ({
      source: "Wikipedia",
      title: s.title + " — " + s.snippet.replace(/<[^>]+>/g, ""),
      url: "https://id.wikipedia.org/wiki/" + encodeURIComponent(s.title),
    }));
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

// ===== Submit =====
$("checkForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("newsInput").value.trim();
  if (!input) return;

  // Analisis otomatis (link Google tersedia di bagian "Cek manual")
  $("checkBtn").disabled = true;
  $("result").classList.add("hidden");
  $("loading").classList.remove("hidden");

  const query = input.split(/[.!?\n]/).map(s => s.trim()).find(s => s.split(/\s+/).length >= 3) || input;
  const names = Object.keys(SOURCES);
  $("loadingText").textContent = "Mencari di media berita terpercaya...";
  const results = await Promise.allSettled(names.map(n => SOURCES[n](query)));

  // Berita dari media terpercaya → dikirim ke Gemini sebagai bukti
  const trustedNews = (results[0].status === "fulfilled" ? results[0].value : []).slice(0, 12);
  const ctx = trustedNews.map(a => `- [${a.media}] ${a.title} (${a.date.slice(5, 16)})`).join("\n");
  $("loadingText").textContent = "Gemini AI menganalisis berita...";

  const gem = await fetch(`/gemini?q=${encodeURIComponent(input)}&ctx=${encodeURIComponent(ctx)}`)
    .then(r => r.json()).catch(e => ({ error: e.message }));
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
    verdict = "hoax"; list = [];
    msg = "Berita ini <b>tidak ditemukan</b> di sumber terpercaya. Gunakan tombol cek manual di bawah untuk memastikan.";
    conf = 60;
  }

  // Gemini menilai berdasarkan berita media terpercaya
  if (gemOk) {
    verdict = gem.verdict === "FAKTA" ? "fakta" : "hoax";
    conf = Math.max(0, Math.min(99, Number(gem.confidence) || 70));
    msg = `🤖 <b>Gemini AI</b> (berdasarkan ${trustedNews.length} berita media terpercaya): ${gem.explanation || ""}`;
    const rel = trustedNews.map(a => ({ ...a, ...matchScore(query, a.title) })).sort((a, b) => b.score - a.score);
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
