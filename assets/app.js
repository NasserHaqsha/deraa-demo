/* درع · منطق الواجهة. بدون مكتبات: كل شي هنا يكلم الخادم المحلي (src/deraa/web.py). */
"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const STATIC = !!window.DERAA_STATIC;   // نسخة عرض على الويب: بدون خادم، والبيانات من العرض التجريبي
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VERDICTS = {
  compliant: { label: "ممتثل", icon: "ok" },
  partial: { label: "ممتثل جزئيًا", icon: "half" },
  non_compliant: { label: "غير ممتثل", icon: "nok" },
  insufficient_evidence: { label: "يحتاج مراجعة", icon: "ask" },
  needs_evidence: { label: "يحتاج دليل تطبيق", icon: "clip" },
};
const VERDICT_HELP = {
  compliant: "في سياستك بند إلزامي يغطي كل ما يطلبه الضابط.",
  partial: "في سياستك بند عن الموضوع، لكن ينقصه جزء مما يطلبه الضابط أو صيغته غير إلزامية.",
  non_compliant: "لا يوجد في سياساتك بند ينص على هذا الضابط.",
  insufficient_evidence: "أشار النموذج إلى بند، لكن الاقتباس لم يطابق نص السياسة حرفيًا، فيحتاج مدققًا يتأكد منه.",
  needs_evidence: "ضابط تطبيق: لا تكفي السياسة لإثباته، ويحتاج دليلًا من الواقع مثل السجلات والإعدادات والتقارير.",
};
const ORDER = ["compliant", "partial", "non_compliant", "insufficient_evidence", "needs_evidence"];

const state = {
  meta: null, health: null, uploads: [], category: "A", judge: "llm",
  job: null, result: null, poll: null, gapFilter: null, allFilter: null, query: "",
};

/* ---------- أدوات ---------- */
function fillIcons(root = document) {
  $$("[data-icon]", root).forEach((el) => { if (!el.firstChild) el.innerHTML = icon(el.dataset.icon); });
}
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const type = res.headers.get("Content-Type") || "";
  const data = type.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error((data && data.error) || `خطأ ${res.status}`);
  return data;
}
const postJSON = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}
function countWord(n) {
  if (n === 1) return "ضابط واحد";
  if (n === 2) return "ضابطان";
  if (n >= 3 && n <= 10) return `${n} ضوابط`;
  return `${n} ضابطًا`;
}
function duration(sec) {
  if (sec == null) return "";
  if (sec < 60) return "أقل من دقيقة";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  const mins = m === 0 ? "" : m === 1 ? "دقيقة" : m === 2 ? "دقيقتان" : m <= 10 ? `${m} دقائق` : `${m} دقيقة`;
  if (!h) return mins;
  const hours = h === 1 ? "ساعة" : h === 2 ? "ساعتان" : h <= 10 ? `${h} ساعات` : `${h} ساعة`;
  return mins ? `${hours} و${mins}` : hours;
}
function gapWord(n) {
  if (n === 1) return "فجوة واحدة";
  if (n === 2) return "فجوتان";
  if (n >= 3 && n <= 10) return `${n} فجوات`;
  return `${n} فجوة`;
}
const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} ميجا` : `${Math.max(1, Math.round(b / 1024))} كيلو`);
const pct = (x) => `${Math.round(x * 100)}%`;
const subOf = (id) => state.meta.unit_sub[id];
const subName = (sid) => (state.meta.subcomponents.find((s) => s.id === sid) || {}).name || sid;
const subIcon = (sid) => (state.meta.subcomponents.find((s) => s.id === sid) || {}).icon || "shield";
const badge = (v) => `<span class="badge b-${v}">${esc(VERDICTS[v].label)}</span>`;

/* ---------- خريطة الدرع ---------- */
/* خلايا مربعة: صفوف كاملة وبعدها كل صف ينقص خلية من كل جهة لين رأس الدرع. لـ 98 ضابط تطلع 11 × 12.
   في الرئيسية الخلايا ترسم الشعار: النص الأيسر مصمت، والأيمن أسطر سياسة مصفوفة من اليمين. */
const GLYPH = (() => {
  const s = new Set();
  for (let r = 0; r < 12; r++) for (let c = 0; c <= 4; c++) s.add(`${r}:${c}`);   // النص المصمت
  [[2, 4], [4, 3], [6, 4], [8, 2]].forEach(([r, n]) => {                           // أسطر السياسة
    const last = 9 - Math.max(0, r - 6);                                            // خلية فراغ قبل حافة الدرع، والدرع يضيق تحت
    for (let c = last; c > last - n; c--) s.add(`${r}:${c}`);
  });
  return s;
})();
function shieldRows(n) {
  let best = null;
  for (let W = 3; W <= 25; W++) {
    const taper = [];
    for (let w = W - 2; w >= 1; w -= 2) taper.push(w);
    const t = taper.reduce((a, b) => a + b, 0);
    const k = Math.max(1, Math.ceil((n - t) / W));
    const rows = Array(k).fill(W).concat(taper);
    const total = k * W + t;
    const score = (total - n) / n + Math.abs(rows.length / W - 1.09) * 0.5;
    if (!best || score < best.score) best = { rows, k, W, score };
  }
  return best;
}
function decoSlots(W, rows, extra) {
  // الخلايا الزايدة على زوايا الدرع العلوية بالتساوي، والفردية في رأسه
  const out = new Set();
  const pairs = [];
  for (let d = 0; d < W; d++) for (let r = 0; r <= d; r++) { const c = d - r; if (r < rows.length && c < W / 2) pairs.push([r, c]); }
  let i = 0;
  while (extra >= 2 && i < pairs.length) { const [r, c] = pairs[i++]; out.add(`${r}:${c}`); out.add(`${r}:${W - 1 - c}`); extra -= 2; }
  if (extra) { const last = rows.length - 1; out.add(`${last}:${(W - rows[last]) / 2}`); }
  return out;
}
function buildMosaic(host, units, { clickable = false } = {}) {
  const P = 10, S = 8.2, RX = 1.1;
  const { rows, k, W } = shieldRows(units.length);
  const total = rows.reduce((a, b) => a + b, 0);
  const deco = decoSlots(W, rows, total - units.length);
  const letters = W === 11 && rows.length === 12;
  const cells = [];
  let idx = 0;
  rows.forEach((w, r) => {
    const c0 = (W - w) / 2;
    for (let c = c0 + w - 1; c >= c0; c--) {   // من اليمين لليسار مثل القراءة
      const key = `${r}:${c}`;
      const isDeco = deco.has(key);
      cells.push({ r, c, x: (c - (W - 1) / 2) * P, y: r * P, id: isDeco ? null : units[idx++] || null, glyph: letters && GLYPH.has(key) });
    }
  });
  const X = (W * P) / 2 + 7, top = -P / 2 - 7, R = 4;
  const yK = (k - 1) * P + P / 2, bot = (rows.length - 1) * P + P / 2 + 17;
  const edge = `M${-X + R},${top}H${X - R}Q${X},${top} ${X},${top + R}V${yK}`
    + `C${X},${yK + (bot - yK) * 0.55} ${X * 0.4},${bot - (bot - yK) * 0.12} 0,${bot}`
    + `C${-X * 0.4},${bot - (bot - yK) * 0.12} ${-X},${yK + (bot - yK) * 0.55} ${-X},${yK}V${top + R}Q${-X},${top} ${-X + R},${top}Z`;
  const pad = 4, vb = `${-X - pad} ${top - pad} ${2 * X + 2 * pad} ${bot - top + 2 * pad}`;
  const uid = Math.random().toString(36).slice(2, 8);
  host.innerHTML = `
    <svg viewBox="${vb}" role="img">
      <defs>
        <linearGradient id="beam-${uid}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#46B88D" stop-opacity="0"/>
          <stop offset="1" stop-color="#46B88D" stop-opacity=".22"/>
        </linearGradient>
        <clipPath id="clip-${uid}"><path d="${edge}"/></clipPath>
      </defs>
      <path class="shield-edge" d="${edge}"/>
      <g class="cells">${cells.map((c, i) => `<rect class="cell${c.id ? "" : " deco"}" data-i="${i}" ${c.id ? `data-id="${c.id}"` : ""} x="${(c.x - S / 2).toFixed(2)}" y="${(c.y - S / 2).toFixed(2)}" width="${S}" height="${S}" rx="${RX}"/>`).join("")}</g>
      <g clip-path="url(#clip-${uid})"><g class="beam"><rect x="${-X}" y="${-P * 3}" width="${2 * X}" height="${P * 3}" fill="url(#beam-${uid})"/><rect class="beam-line" x="${-X}" y="-0.6" width="${2 * X}" height="1.2"/></g></g>
    </svg>`;
  const els = $$(".cell", host);
  cells.forEach((c, i) => (c.el = els[i]));
  const byId = {};
  cells.forEach((c) => { if (c.id) byId[c.id] = c.el; });
  const beam = $(".beam", host);
  if (clickable) host.classList.add("mosaic-click");
  return {
    host, cells, byId, rows, P,
    set(id, v, animate = false) {
      const el = byId[id];
      if (!el) return;
      el.dataset.v = v;
      el.classList.remove("now", "glyph");
      if (animate && !reduceMotion) { el.classList.remove("lit"); void el.getBBox(); el.classList.add("lit"); }
    },
    clear() { cells.forEach((c) => { delete c.el.dataset.v; c.el.classList.remove("now", "lit", "glyph"); }); },
    beamAt(y) {
      if (y == null) { beam.style.opacity = "0"; return; }
      beam.style.opacity = "1";
      beam.style.transform = `translateY(${y + P / 2 + 0.6}px)`;
    },
    now(id) {
      $$(".cell.now", host).forEach((el) => el.classList.remove("now"));
      const el = byId[id];
      if (!el) { this.beamAt(null); return; }
      el.classList.add("now");
      this.beamAt(cells[+el.dataset.i].y);
    },
    highlight(ids) {
      $$(".cell.hl", host).forEach((el) => el.classList.remove("hl"));
      host.classList.toggle("dim-others", !!ids);
      (ids || []).forEach((id) => byId[id] && byId[id].classList.add("hl"));
    },
  };
}

/* حركة الرئيسية: الخلايا ترسم الشعار (المصمت ثم الأسطر من اليمين)، وبعدها مسح يلوّنها بأحكام توضيحية، ويعيد */
let heroTimer = null;
function heroLoop(m) {
  clearTimeout(heroTimer);
  const glyph = m.cells.filter((c) => c.glyph).sort((a, b) => (a.c <= 4) - (b.c <= 4) || a.r - b.r || b.c - a.c);
  if (reduceMotion) { glyph.forEach((c) => c.el.classList.add("glyph")); return; }
  const ids = m.cells.filter((c) => c.id);
  const alive = () => {
    const view = m.host.closest(".view");
    return document.body.contains(m.host) && !(view && view.hidden);
  };
  const wait = (ms) => new Promise((r) => { heroTimer = setTimeout(r, ms); });
  const run = async () => {
    while (alive()) {
      for (const c of glyph) { if (!alive()) return; c.el.classList.add("glyph", "lit"); setTimeout(() => c.el.classList.remove("lit"), 600); await wait(34); }
      await wait(2200);
      for (const c of ids) {
        if (!alive()) return;
        m.beamAt(c.y);
        m.set(c.id, sampleVerdict(c.id), true);
        await wait(24);
      }
      m.beamAt(null);
      await wait(4200);
      m.clear();
      await wait(900);
    }
  };
  heroTimer = setTimeout(run, 500);
}
function sampleVerdict(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  const x = h % 100;
  return x < 54 ? "compliant" : x < 72 ? "partial" : x < 86 ? "non_compliant" : "needs_evidence";
}

/* ---------- حركة الخلفية ----------
   شبكة خلايا خافتة خلف الأشرطة الداكنة (نفس فكرة خريطة الضوابط): خلايا تنور وتطفي بهدوء،
   وخط مسح يمر كل كم ثانية وينوّر اللي يمر عليه، والخلايا القريبة من الماوس تنور مثل الكشاف.
   تشتغل بس لما القسم ظاهر والصفحة مفتوحة، وتوقف مع «تقليل الحركة». */
const FX_COLORS = ["70,184,141", "34,184,207", "101,116,232", "212,180,106"];   // يشم، سماوي، نيلي، ذهبي
const FX = { items: [], raf: 0, last: 0 };
function mountFx(root = document) {
  $$("canvas.fx", root).forEach((cv) => {
    if (cv._fx) return;
    const host = cv.closest(".fx-host");
    const it = { cv, host, ctx: cv.getContext("2d"), w: 0, h: 0, dpr: 1, P: 26, S: 15, cols: 0, rows: 0,
      lit: new Map(), ptr: null, visible: false, scanT: Math.random() * 6000, base: null };
    cv._fx = it;
    const size = () => {
      const r = host.getBoundingClientRect();
      it.dpr = Math.min(window.devicePixelRatio || 1, 2);
      it.w = Math.max(1, r.width); it.h = Math.max(1, r.height);
      cv.width = Math.round(it.w * it.dpr); cv.height = Math.round(it.h * it.dpr);
      it.cols = Math.ceil(it.w / it.P) + 1; it.rows = Math.ceil(it.h / it.P) + 1;
      // نقاط الشبكة الثابتة نرسمها مرة وحدة
      const b = document.createElement("canvas");
      b.width = cv.width; b.height = cv.height;
      const g = b.getContext("2d");
      g.scale(it.dpr, it.dpr);
      g.fillStyle = "rgba(236,241,245,.055)";
      for (let i = 0; i < it.cols; i++) for (let j = 0; j < it.rows; j++) g.fillRect(i * it.P + it.P / 2 - 1, j * it.P + it.P / 2 - 1, 2, 2);
      it.base = b;
      draw(it, performance.now());
    };
    new ResizeObserver(size).observe(host);
    new IntersectionObserver(([e]) => { it.visible = e.isIntersecting; loopFx(); }).observe(host);
    host.addEventListener("pointermove", (e) => { const r = host.getBoundingClientRect(); it.ptr = { x: e.clientX - r.left, y: e.clientY - r.top }; });
    host.addEventListener("pointerleave", () => { it.ptr = null; });
    FX.items.push(it);
    size();
  });
  loopFx();
}
function lightCell(it, i, j, now, color, peak = 0.28) {
  const k = `${i}:${j}`;
  if (!it.lit.has(k)) it.lit.set(k, { i, j, t0: now, dur: 1800 + Math.random() * 1600, color, peak });
}
function draw(it, now) {
  const { ctx, P, S } = it;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, it.cv.width, it.cv.height);
  if (it.base) ctx.drawImage(it.base, 0, 0);
  ctx.setTransform(it.dpr, 0, 0, it.dpr, 0, 0);
  const cell = (i, j, rgb, a) => {
    ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
    const x = i * P + (P - S) / 2, y = j * P + (P - S) / 2;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, S, S, 2.5); ctx.fill(); } else ctx.fillRect(x, y, S, S);
  };
  for (const [k, c] of it.lit) {
    const t = (now - c.t0) / c.dur;
    if (t >= 1) { it.lit.delete(k); continue; }
    const a = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
    cell(c.i, c.j, c.color, c.peak * a);
  }
  if (it.ptr) {
    const R = 150, ci = Math.floor(it.ptr.x / P), cj = Math.floor(it.ptr.y / P), n = Math.ceil(R / P);
    for (let i = ci - n; i <= ci + n; i++) for (let j = cj - n; j <= cj + n; j++) {
      const dx = i * P + P / 2 - it.ptr.x, dy = j * P + P / 2 - it.ptr.y, d = Math.hypot(dx, dy);
      if (d < R) cell(i, j, FX_COLORS[1], 0.16 * Math.pow(1 - d / R, 2));
    }
  }
  // خط المسح
  const period = 11000, run = 4200, t = (now + it.scanT) % period;
  if (t < run) {
    const y = (t / run) * (it.h + 80) - 40;
    const g = ctx.createLinearGradient(0, y - 70, 0, y);
    g.addColorStop(0, "rgba(34,184,207,0)"); g.addColorStop(1, "rgba(34,184,207,.07)");
    ctx.fillStyle = g; ctx.fillRect(0, y - 70, it.w, 70);
    ctx.fillStyle = "rgba(70,184,141,.35)"; ctx.fillRect(0, y, it.w, 1);
    const j = Math.floor(y / P);
    if (j >= 0 && Math.random() < 0.5) lightCell(it, Math.floor(Math.random() * it.cols), j, now, FX_COLORS[Math.random() < 0.6 ? 0 : 1], 0.26);
  }
}
function loopFx() {
  if (reduceMotion || FX.raf) return;
  const tick = (now) => {
    FX.raf = 0;
    const live = FX.items.filter((it) => it.visible && document.body.contains(it.cv) && !it.cv.closest("[hidden]"));
    if (!live.length || document.hidden) return;
    if (now - FX.last > 33) {   // 30 إطار بالثانية يكفي، ويريّح الجهاز وقت تحليل النموذج
      FX.last = now;
      live.forEach((it) => {
        const spawn = (it.cols * it.rows) / 1000;
        if (Math.random() < spawn) lightCell(it, Math.floor(Math.random() * it.cols), Math.floor(Math.random() * it.rows), now, FX_COLORS[Math.floor(Math.random() * 4)]);
        draw(it, now);
      });
    }
    FX.raf = requestAnimationFrame(tick);
  };
  FX.raf = requestAnimationFrame(tick);
}
document.addEventListener("visibilitychange", loopFx);

/* ميلان خفيف للدرع مع حركة الماوس في الرئيسية */
function bindTilt() {
  const fig = $(".hero-shield");
  if (!fig || reduceMotion) return;
  const m = $("#hero-mosaic");
  let raf = 0;
  fig.closest(".hero-band").addEventListener("pointermove", (e) => {
    const r = fig.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) / r.width, y = (e.clientY - (r.top + r.height / 2)) / r.height;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { m.style.transform = `perspective(1000px) rotateY(${(x * 8).toFixed(2)}deg) rotateX(${(-y * 6).toFixed(2)}deg)`; });
  });
  fig.closest(".hero-band").addEventListener("pointerleave", () => { m.style.transform = ""; });
}

/* ظهور الأقسام مرة وحدة لما توصلها */
function bindReveal() {
  const els = $$(".reveal, .reveal-group > *");
  if (reduceMotion || !("IntersectionObserver" in window)) { els.forEach((el) => el.classList.add("in")); return; }
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.15 });
  $$(".reveal-group").forEach((g) => [...g.children].forEach((el, i) => (el.style.transitionDelay = `${i * 110}ms`)));
  els.forEach((el) => io.observe(el));
}

/* ---------- التنقل ---------- */
function show(view) {
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  loopFx();
  $$(".nav [data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === view));
  window.scrollTo({ top: 0 });
}
const go = (page, id) => { location.hash = id ? `#${page}-${id}` : `#${page}`; };
async function route() {
  const h = (location.hash || "").replace(/^#\/?/, "");
  const [page, ...rest] = h.split(/[-/]/);
  const id = rest.join("-") || null;
  clearInterval(state.poll);
  if (page === "setup") { show("setup"); renderSetup(); return; }
  if (page === "scan" && id) { show("scan"); startScan(id); return; }
  if (page === "results" && id) { show("results"); loadResults(id); return; }
  show("home");
  heroLoop(buildMosaic($("#hero-mosaic"), state.meta.units.A));
}

/* ---------- الحالة ---------- */
async function checkHealth() {
  try {
    state.health = await api("/api/health");
  } catch {
    state.health = { ollama: false, model_ready: false, message: "الخادم المحلي لا يستجيب" };
  }
  const s = $("#status");
  s.classList.toggle("ok", state.health.model_ready);
  s.classList.toggle("warn", !state.health.model_ready);
  $(".status-text", s).textContent = STATIC ? "نسخة عرض على الويب"
    : state.health.model_ready ? "النموذج المحلي جاهز" : "النموذج المحلي غير متاح: الفحص السريع فقط";
  s.title = state.health.message || "";
  if (!$("[data-view=setup]").hidden) renderModes();
}

/* ---------- فحص جديد ---------- */
function renderSetup() {
  const cat = $("#category");
  cat.innerHTML = Object.keys(state.meta.categories).map((c) => {
    const n = state.meta.units[c].length;
    const name = c === "A" ? "الفئة (أ)" : "الفئة (ب)";
    const sub = c === "A" ? `جهة كبيرة، ${countWord(n)}` : `جهة صغيرة أو متوسطة، ${countWord(n)}`;
    return `<button type="button" class="opt" role="radio" aria-checked="${state.category === c}" data-cat="${c}"><strong>${name}</strong><span>${sub}</span></button>`;
  }).join("");
  renderModes();
  renderFiles();
}
function renderModes() {
  const ready = state.health && state.health.model_ready;
  if (!ready && state.judge === "llm") state.judge = "rule";
  const judged = state.meta.judged[state.category];
  const llmEta = duration(judged * state.meta.seconds_per_control.llm);
  $("#modes").innerHTML = `
    <button type="button" class="opt" role="radio" data-judge="llm" aria-checked="${state.judge === "llm"}" aria-disabled="${!ready}">
      ${icon("chip")}<strong>تحليل دقيق بالنموذج المحلي</strong>
      <span>${esc(state.meta.llm.model)} يقرأ كل بند، ويسمّي العنصر الناقص، ويقتبس الدليل من سياستك.</span>
      <span class="eta">قرابة ${llmEta} على هذا الجهاز</span>
    </button>
    <button type="button" class="opt" role="radio" data-judge="rule" aria-checked="${state.judge === "rule"}">
      ${icon("search")}<strong>فحص سريع بالكلمات</strong>
      <span>يطابق الكلمات المشتركة بين الضابط وسياستك. نتيجته تقريبية، ومناسب للتجربة.</span>
      <span class="eta">ثوانٍ</span>
    </button>`;
  const warn = $("#mode-warn");
  warn.hidden = ready;
  warn.textContent = ready ? "" : (state.health && state.health.message) || "النموذج المحلي غير متاح.";
}
function renderFiles() {
  $("#files").innerHTML = state.uploads.map((u, i) => `
    <li>${icon("file")}<span class="fname" title="${esc(u.name)}">${esc(u.name)}</span><span class="fsize">${size(u.size)}</span>
      <span class="fstate ${u.state === "ready" ? "ok" : u.state === "error" ? "bad" : ""}">${u.state === "ready" ? "جاهز" : u.state === "error" ? esc(u.error) : "يُرفع…"}</span>
      <button type="button" class="frm" data-rm="${i}" aria-label="احذف ${esc(u.name)}">${icon("x")}</button></li>`).join("");
}
async function addFiles(list) {
  for (const f of list) {
    const u = { name: f.name, size: f.size, state: "uploading", id: null, error: "" };
    if (!/\.(pdf|docx)$/i.test(f.name)) { u.state = "error"; u.error = "PDF أو Word فقط"; }
    else if (f.size > 50 * 1048576) { u.state = "error"; u.error = "أكبر من 50 ميجا"; }
    state.uploads.push(u);
    renderFiles();
    if (u.state === "error") continue;
    try {
      const res = await api("/api/upload", { method: "POST", headers: { "X-Filename": encodeURIComponent(f.name) }, body: await f.arrayBuffer() });
      u.id = res.id; u.state = "ready";
    } catch (e) { u.state = "error"; u.error = e.message; }
    renderFiles();
  }
}
async function submitSetup(ev) {
  ev.preventDefault();
  const msg = $("#form-msg");
  msg.textContent = "";
  const ids = state.uploads.filter((u) => u.state === "ready").map((u) => u.id);
  if (!ids.length) { msg.textContent = "ارفع ملف سياسة واحدًا على الأقل."; return; }
  if (state.uploads.some((u) => u.state === "uploading")) { msg.textContent = "انتظر حتى يكتمل رفع الملفات."; return; }
  const btn = $("#start");
  btn.disabled = true;
  try {
    const { job } = await postJSON("/api/analyze", { uploads: ids, company: $("#company").value, category: state.category, judge: state.judge });
    go("scan", job);
  } catch (e) { msg.textContent = e.message; }
  finally { btn.disabled = false; }
}

/* ---------- الفحص الحي ---------- */
async function startScan(id) {
  let p;
  try { p = await api(`/api/jobs/${id}`); }
  catch (e) { scanError(e.message); return; }
  if (p.status === "done" && !p.demo) { go("results", id); return; }
  const units = state.meta.units[p.category] || state.meta.units.A;
  const m = buildMosaic($("#scan-mosaic"), units);
  $("#scan-kicker").textContent = p.demo ? "عرض تجريبي" : "جاري الفحص";
  $("#scan-title").textContent = `نفحص سياسات ${p.company}`;
  $("#feed").innerHTML = "";
  setRing(0, units.length);
  $("#cancel").hidden = !!p.demo;
  $("#cancel").onclick = async () => {
    if (!confirmCancel()) return;
    await postJSON(`/api/jobs/${id}/cancel`).catch(() => {});
    toast("أوقفنا التحليل");
  };
  const queue = [];
  let shown = 0, since = 0, finished = false, lastP = p;
  const pump = async () => {
    while (!finished || queue.length) {
      if (queue.length) {
        const e = queue.shift();
        m.set(e.control_id, e.verdict, true);
        shown++;
        setRing(shown, lastP.total || units.length);
        pushFeed(e);
        m.now(units[shown] || null);
        await sleep(p.demo ? 55 : 70);
      } else { await sleep(120); }
    }
    m.now(null);
  };
  const tick = async () => {
    try {
      const q = await api(`/api/jobs/${id}?since=${since}`);
      lastP = q;
      since = q.next;
      queue.push(...q.events);
      if (q.status === "running" && shown === 0 && !q.events.length) m.now(units[0]);
      $("#scan-eta").textContent = q.status === "running"
        ? (q.eta != null ? `متبقٍ قرابة ${duration(q.eta)}` : "نجهّز البحث في سياساتك…")
        : "";
      if (q.status !== "running" && q.status !== "queued") {
        finished = true;
        clearInterval(state.poll);
        await pumpDone;
        if (q.status === "done") { await sleep(500); go("results", id); }
        else if (q.status === "cancelled") { $("#scan-eta").textContent = "توقف التحليل."; }
        else scanError(q.error || "تعذّر إكمال التحليل");
      }
    } catch (e) { clearInterval(state.poll); scanError(e.message); }
  };
  const pumpDone = pump();
  await tick();
  if (!finished) state.poll = setInterval(tick, p.judge === "llm" ? 1500 : 500);
}
function confirmCancel() { return window.confirm("هل تريد إيقاف التحليل؟ لن تُحفظ الأحكام التي صدرت حتى الآن."); }
function setRing(n, total) {
  const C = 326.7;
  $("#scan-ring").style.strokeDashoffset = String(C - C * (total ? n / total : 0));
  $("#scan-n").textContent = n;
  $("#scan-total").textContent = `من ${total} ضابط`;
}
function pushFeed(e) {
  const feed = $("#feed");
  const sid = subOf(e.control_id);
  const li = document.createElement("li");
  li.innerHTML = `<span style="color:var(--${e.verdict})">${icon(VERDICTS[e.verdict].icon)}</span><span class="cid">${esc(e.control_id)}</span><span class="sub">${esc(subName(sid))}</span>${badge(e.verdict)}`;
  feed.prepend(li);
  while (feed.children.length > 6) feed.lastChild.remove();
}
function scanError(text) {
  $("#scan-eta").textContent = text;
  $("#scan-kicker").textContent = "توقف الفحص";
  toast(text, true);
}

/* ---------- النتائج ---------- */
async function loadResults(id) {
  const host = $("#results");
  host.innerHTML = `<div class="wrap results-body"><p class="filter-note">نجهّز النتائج…</p></div>`;
  try {
    state.result = await api(`/api/jobs/${id}/result`);
  } catch (e) {
    host.innerHTML = `<div class="wrap results-body"><div class="panel"><h2>تعذّر عرض النتائج</h2><p class="filter-note">${esc(e.message)}</p><p style="margin-top:14px"><a class="btn btn-primary" href="#setup">ابدأ فحصًا جديدًا</a></p></div></div>`;
    return;
  }
  state.job = id;
  state.gapFilter = null; state.allFilter = null; state.query = "";
  renderResults();
}
function headlineText(R) {
  const c = R.counts;
  const gaps = c.non_compliant + c.partial + c.insufficient_evidence;
  if (!gaps) return "لم نجد فجوات في الضوابط التي تُحكم من السياسة.";
  const weak = R.weakest.map((s) => subName(s));
  let t = `${countWord(gaps)} يحتاج تصحيحًا: ${c.non_compliant} بلا أي بند في سياساتك، و${c.partial} ناقص جزئيًا`;
  if (c.insufficient_evidence) t += `، و${c.insufficient_evidence} يحتاج مراجعة`;
  t += ".";
  if (weak.length) t += ` أضعف المجالات: ${weak.join("، ")}.`;
  return t;
}
function scoreColor(s) { return s >= 0.8 ? "var(--compliant)" : s >= 0.5 ? "var(--partial)" : "var(--non_compliant)"; }
function scoreText(s) { return s >= 0.8 ? "var(--t-compliant)" : s >= 0.5 ? "var(--t-partial)" : "var(--t-non_compliant)"; }

function renderResults() {
  const R = state.result;
  const host = $("#results");
  const gaps = R.gap_order.map((id) => R.controls.find((c) => c.id === id));
  const kpi = (v) => `<button type="button" class="kpi k-${v}" data-kpi="${v}"><strong data-count="${R.counts[v] || 0}">0</strong><span>${icon(VERDICTS[v].icon)}${VERDICTS[v].label}</span></button>`;
  host.innerHTML = `
    <div class="res-band night fx-host"><div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div><canvas class="fx" aria-hidden="true"></canvas><div class="wrap">
    <div class="res-head">
      <div class="gauge" role="img" aria-label="نسبة الامتثال ${pct(R.score)}">
        <svg viewBox="0 0 170 170"><circle class="g-bg" cx="85" cy="85" r="75"/><circle class="g-fg" id="gauge-fg" cx="85" cy="85" r="75" stroke="${scoreColor(R.score)}"/></svg>
        <div class="gauge-text"><strong id="gauge-n">0%</strong><span>نسبة الامتثال</span><em class="g-label" style="color:${scoreText(R.score)}">${esc(R.score_label)}</em></div>
      </div>
      <div class="res-title">
        <h1 id="res-title">${esc(R.company)}</h1>
        <div class="meta">
          <span>${icon("doc")}${esc(R.category_label)}</span>
          <span>${icon(R.mode === "llm" ? "chip" : "search")}${R.mode === "llm" ? `تحليل دقيق (${esc(R.model)})` : "فحص سريع بالكلمات"}</span>
          <span>${icon("file")}${R.files.map((f) => `<bdi>${esc(f)}</bdi>`).join("، ")}</span>
        </div>
        <p class="head-line">${esc(headlineText(R))}</p>
      </div>
      <div class="res-actions">${STATIC ? `
        <a class="btn btn-primary" href="report.html" target="_blank" rel="noopener">${icon("report")} افتح التقرير الكامل</a>
        <span class="filter-note">ويمكن طباعته PDF من المتصفح.</span>` : `
        <button type="button" class="btn btn-primary" id="dl-pdf">${icon("download")} تحميل التقرير PDF</button>
        <a class="btn btn-ghost" href="/api/jobs/${R.id}/report.html" target="_blank" rel="noopener">${icon("report")} التقرير كصفحة ويب</a>
        <a class="btn btn-ghost" href="/api/jobs/${R.id}/results.csv" download>${icon("data")} جدول الأحكام (Excel)</a>`}
      </div>
    </div>
    ${R.mode === "rule" ? `<p class="note-bar mode-note">${icon("ask")}<span>هذه نتيجة الفحص السريع بالكلمات: يعدّ الكلمات المشتركة ولا يفهم المعنى، فأحكامه تقريبية. للتحليل الدقيق أعد الفحص بالنموذج المحلي.</span></p>` : ""}
    ${R.demo ? `<p class="note-bar demo-note">${icon("play")}<span>عرض تجريبي على شركة وهمية بنيناها من نماذج سياسات الهيئة، وأحكامه من تشغيل سابق للنموذج المحلي.</span></p>` : ""}
    <div class="kpis">${ORDER.map(kpi).join("")}</div>
    </div></div>

    <div class="wrap results-body">

    <div class="map">
      <div class="map-shield">
        <h2>خريطة الضوابط</h2>
        <div class="mosaic" id="res-mosaic"></div>
        <div class="legend">${ORDER.map((v) => `<span><i style="background:var(--${v})"></i>${VERDICTS[v].label}</span>`).join("")}</div>
        <p class="map-hint">اضغط على أي خلية لتفاصيل الضابط.</p>
      </div>
      <div class="domains">
        <h2>المجالات</h2>
        ${state.meta.components.map((comp) => {
          const ds = R.components.filter((d) => d.id.split("-")[0] === comp.id);
          if (!ds.length) return "";
          return `<p class="comp-title">${esc(comp.name)}</p>` + ds.map((d) => `
            <button type="button" class="dom c${d.id.split("-")[0]}${d.score == null ? " na" : ""}" data-dom="${d.id}">
              <span class="d-ic">${icon(d.icon)}</span>
              <span class="d-name"><span>${esc(d.name)}</span><small>${countWord(d.controls)}${d.gaps ? `، ${gapWord(d.gaps)}` : ""}</small></span>
              <span class="d-bar"><i data-w="${d.score == null ? 0 : Math.round(d.score * 100)}" style="background:${d.score == null ? "var(--line-2)" : scoreColor(d.score)}"></i></span>
              <span class="d-pct">${d.score == null ? "دليل تطبيق" : pct(d.score)}</span>
            </button>`).join("");
        }).join("")}
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button type="button" class="tab" role="tab" aria-selected="true" data-tab="gaps">الفجوات وتصحيحها<span class="count">${gaps.length}</span></button>
      <button type="button" class="tab" role="tab" aria-selected="false" data-tab="all">كل الضوابط<span class="count">${R.controls.length}</span></button>
      <button type="button" class="tab" role="tab" aria-selected="false" data-tab="file">ملف السياسات<span class="count">${R.file.policies.length}</span></button>
    </div>
    <div class="tabpanel" id="tab-gaps" role="tabpanel"></div>
    <div class="tabpanel" id="tab-all" role="tabpanel" hidden></div>
    <div class="tabpanel" id="tab-file" role="tabpanel" hidden></div>
    </div>`;

  mountFx(host);
  const m = buildMosaic($("#res-mosaic"), state.meta.units[R.category], { clickable: true });
  state.resMosaic = m;
  revealResults(R, m);
  renderGaps();
  renderAll();
  renderFile();

  $("#res-mosaic").addEventListener("click", (e) => {
    const cell = e.target.closest(".cell[data-id]");
    if (cell) openControl(cell.dataset.id);
  });
  if ($("#dl-pdf")) $("#dl-pdf").addEventListener("click", downloadPdf);
}

function revealResults(R, m) {
  const verdict = Object.fromEntries(R.controls.map((c) => [c.id, c.verdict]));
  const ids = state.meta.units[R.category];
  const fg = $("#gauge-fg");
  const C = 471.2;
  requestAnimationFrame(() => { fg.style.strokeDashoffset = String(C - C * R.score); });
  countUp($("#gauge-n"), Math.round(R.score * 100), "%");
  $$("[data-count]").forEach((el) => countUp(el, +el.dataset.count));
  requestAnimationFrame(() => $$(".d-bar i").forEach((i) => (i.style.width = `${i.dataset.w}%`)));
  if (reduceMotion) { ids.forEach((id) => verdict[id] && m.set(id, verdict[id])); return; }
  ids.forEach((id, k) => setTimeout(() => verdict[id] && m.set(id, verdict[id], true), 200 + k * 12));
}
function countUp(el, target, suffix = "") {
  if (reduceMotion) { el.textContent = target + suffix; return; }
  const t0 = performance.now(), dur = 1300;
  const f = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(target * e) + suffix;
    if (k < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}

/* أجزاء بطاقة الضابط: نفسها في الفجوات وفي لوحة التفاصيل */
function controlBody(c, { withRequirement = true } = {}) {
  const R = state.result;
  const parts = [];
  if (withRequirement) parts.push(`<div class="sec"><h4>${icon("doc")}المطلوب في الضابط</h4><p class="req">${esc(c.text)}</p></div>`);
  if (c.verdict === "needs_evidence") {
    parts.push(`<div class="sec"><h4>${icon("clip")}ما المطلوب منك</h4><p>${esc(VERDICT_HELP.needs_evidence)}</p></div>`);
    return parts.join("");
  }
  const src = [c.policy, c.number ? `البند ${c.number}` : ""].filter(Boolean).join("، ");
  parts.push(`<div class="sec"><h4>${icon("search")}ما وجدناه في سياستك</h4>${c.quote
    ? `<div class="quote"><q>${esc(c.quote.slice(0, 700))}</q>${src ? `<small>${esc(src)}</small>` : ""}</div>`
    : `<p class="none">لا يوجد في سياساتك بند ينص على هذا الضابط.</p>`}</div>`);
  if (c.elements.length) {
    parts.push(`<div class="sec"><h4>${icon("check")}عناصر الضابط</h4><ul class="els">${c.elements.map((e) =>
      `<li class="${e.status}">${icon(e.status === "met" ? "ok" : e.status === "weak" ? "half" : "nok")}<span>${esc(e.text)} <em>${esc(e.label)}</em></span></li>`).join("")}</ul></div>`);
  }
  if (c.why) parts.push(`<div class="sec"><h4>${icon("ask")}سبب الحكم</h4><p>${esc(c.why)}</p></div>`);
  if (c.fixes.length) {
    parts.push(`<div class="sec"><h4>${icon("fix")}التصحيح المقترح: أضف هذا البند إلى سياستك</h4>${c.fixes.map((f, i) => `
      <div class="fix"><button type="button" class="copy" data-copy="${esc(c.id)}:${i}" aria-label="انسخ البند">${icon("copy")}</button>
      <p>${esc(f.text)}</p><span class="src">المصدر: ${esc(f.source)}</span></div>`).join("")}</div>`);
  }
  if (c.gap) {
    const ai = R.explained[c.id];
    parts.push(`<div class="sec" data-ai="${esc(c.id)}"><h4>${icon("spark")}شرح النموذج المحلي</h4>${ai ? aiBlock(ai) : `
      <button type="button" class="btn btn-ghost btn-sm" data-explain="${esc(c.id)}">${icon("spark")} اشرح لي واكتب بندًا مخصصًا</button>
      <span class="filter-note" style="margin-inline-start:10px">قرابة دقيقة على هذا الجهاز</span>`}</div>`);
  }
  return parts.join("");
}
function aiBlock(ai) {
  return `<div class="ai"><p>${esc(ai.why)}</p>${ai.fix ? `<div class="ai-fix"><b>البند المقترح:</b> ${esc(ai.fix)}</div>` : ""}${(ai.steps || []).length ? `<ol>${ai.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
}

function renderGaps() {
  const R = state.result;
  let gaps = R.gap_order.map((id) => R.controls.find((c) => c.id === id));
  const f = state.gapFilter;
  if (f) gaps = gaps.filter((c) => c.sub === f);
  const host = $("#tab-gaps");
  if (!R.gap_order.length) { host.innerHTML = `<p class="filter-note">لا توجد فجوات. كل الضوابط التي تُحكم من السياسة ممتثلة.</p>`; return; }
  host.innerHTML = `
    ${f ? `<div class="filter-row"><span class="filter-note">فجوات مجال ${esc(subName(f))} فقط</span><button type="button" class="clear-filter" data-clear-dom>اعرض كل الفجوات</button></div>` : ""}
    ${gaps.length ? gaps.map((c) => `
      <details class="gap v-${c.verdict}" data-gap="${esc(c.id)}">
        <summary>
          ${badge(c.verdict)}
          <span class="g-ic" title="${esc(subName(c.sub))}">${icon(subIcon(c.sub))}</span>
          <span><span class="g-id">${esc(c.id)}</span> <span class="g-text">${esc(c.text)}</span></span>
          <svg class="g-chev ic" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </summary>
        <div class="gap-body">${controlBody(c)}</div>
      </details>`).join("") : `<p class="filter-note">لا توجد فجوات في هذا المجال.</p>`}`;
}

function renderAll() {
  const R = state.result;
  const host = $("#tab-all");
  const q = state.query.trim();
  let list = R.controls;
  if (state.allFilter) list = list.filter((c) => c.verdict === state.allFilter);
  if (q) list = list.filter((c) => c.id.includes(q) || c.text.includes(q) || subName(c.sub).includes(q));
  host.innerHTML = `
    <div class="filter-row">
      <button type="button" class="chip" data-all="" aria-pressed="${!state.allFilter}">الكل</button>
      ${ORDER.map((v) => `<button type="button" class="chip" data-all="${v}" aria-pressed="${state.allFilter === v}">${VERDICTS[v].label} (${R.counts[v] || 0})</button>`).join("")}
      <label class="search">${icon("search")}<input type="search" id="q" placeholder="ابحث برقم الضابط أو كلمة" value="${esc(state.query)}" aria-label="ابحث في الضوابط"></label>
    </div>
    <div class="rows">${list.map((c) => `
      <button type="button" class="row" data-open="${esc(c.id)}">
        <span class="r-id">${esc(c.id)}</span><span class="r-ic" title="${esc(subName(c.sub))}">${icon(subIcon(c.sub))}</span>
        <span class="r-text">${esc(c.text)}</span>${badge(c.verdict)}
      </button>`).join("") || `<p class="filter-note">لا توجد ضوابط تطابق البحث.</p>`}</div>`;
}

function renderFile() {
  const F = state.result.file;
  const host = $("#tab-file");
  const rev = { met: ["موجود ودوري", "compliant"], weak: ["موجود لكن غير دوري أو غير ملزم", "partial"], none: ["لا يوجد", "non_compliant"] };
  host.innerHTML = `
    <div class="file-stats">
      <div><strong>${F.policies.length}</strong><span>سياسة في الملف</span></div>
      <div><strong>${F.n_paragraphs}</strong><span>فقرة قرأناها</span></div>
      <div><strong>${F.mandatory_share == null ? "-" : pct(F.mandatory_share)}</strong><span>من البنود بصيغة إلزامية (يجب، يلزم)</span></div>
    </div>
    ${F.policies.length ? `<table class="ptable">
      <thead><tr><th>السياسة</th><th>البنود</th><th>بصيغة إلزامية</th><th>بند المراجعة الدورية</th><th>ضوابط تثبتها</th></tr></thead>
      <tbody>${F.policies.map((p) => {
        const share = p.clauses ? p.mandatory / p.clauses : 0;
        const [lbl, v] = rev[p.review];
        return `<tr><td>${esc(p.title)}</td><td>${p.clauses}</td><td><span class="mini"><i style="width:${Math.round(share * 100)}%"></i></span>${pct(share)}</td><td>${badgeText(lbl, v)}</td><td>${p.supports}</td></tr>`;
      }).join("")}</tbody></table>` : `<p class="filter-note">لم نتعرف على عناوين سياسات منفصلة في الملف.</p>`}
    <div class="note-list">
      ${F.no_review.length ? `<p><b>سياسات بلا بند مراجعة دورية:</b> ${esc(F.no_review.join("، "))}. الهيئة تطلب مراجعة كل سياسة دوريًا.</p>` : ""}
      ${F.missing_topics.length ? `<p><b>مواضيع في نماذج الهيئة لم نجد لها سياسة باسمها:</b> ${esc(F.missing_topics.join("، "))}. قد يكون محتواها داخل سياسة أخرى، فراجع ضوابطها.</p>` : ""}
    </div>`;
}
const badgeText = (label, v) => `<span class="badge b-${v}">${esc(label)}</span>`;

function openControl(id) {
  const c = state.result.controls.find((x) => x.id === id);
  if (!c) return;
  $("#drawer-body").innerHTML = `
    <div class="d-head">
      <span class="d-dom">${icon(subIcon(c.sub))}${esc(subName(c.sub))}</span>
      <div style="display:flex;gap:10px;align-items:center"><span class="g-id" style="direction:ltr;color:var(--muted)">${esc(c.id)}</span>${badge(c.verdict)}</div>
      <h3 id="drawer-title">${esc(c.text)}</h3>
    </div>
    ${controlBody(c, { withRequirement: false })}`;
  const d = $("#drawer");
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
  $(".drawer-panel", d).focus();
}
function closeDrawer() {
  const d = $("#drawer");
  d.classList.remove("open");
  d.setAttribute("aria-hidden", "true");
}

async function explain(id, btn) {
  const sec = btn.closest("[data-ai]");
  btn.disabled = true;
  btn.innerHTML = `<span class="thinking"><i></i><i></i><i></i> النموذج المحلي يكتب الشرح…</span>`;
  try {
    const ai = await postJSON(`/api/jobs/${state.job}/explain`, { control_id: id });
    state.result.explained[id] = ai;
    $$(`[data-ai="${CSS.escape(id)}"]`).forEach((s) => { s.innerHTML = `<h4>${icon("spark")}شرح النموذج المحلي</h4>${aiBlock(ai)}`; });
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = `${icon("spark")} حاول مرة ثانية`;
    toast(e.message, true);
    void sec;
  }
}

async function downloadPdf() {
  const btn = $("#dl-pdf");
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="thinking"><i></i><i></i><i></i> نجهّز التقرير…</span>`;
  try {
    const blob = await api(`/api/jobs/${state.job}/report.pdf`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "deraa_report.pdf";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("تم تنزيل التقرير");
  } catch (e) {
    toast(`${e.message} افتح «التقرير كصفحة ويب» واطبعه PDF.`, true);
  } finally { btn.disabled = false; btn.innerHTML = old; }
}

async function startDemo() {
  try {
    const { job } = await postJSON("/api/demo");
    go("scan", job);
  } catch (e) { toast(e.message, true); }
}

/* ---------- الأحداث ---------- */
function bind() {
  window.addEventListener("hashchange", route);
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.dataset.action === "demo") { e.preventDefault(); startDemo(); }
    else if (t.dataset.cat) { state.category = t.dataset.cat; renderSetup(); }
    else if (t.dataset.judge) {
      if (t.getAttribute("aria-disabled") === "true") { toast((state.health && state.health.message) || "النموذج المحلي غير متاح", true); return; }
      state.judge = t.dataset.judge; renderModes();
    }
    else if (t.dataset.rm) { state.uploads.splice(+t.dataset.rm, 1); renderFiles(); }
    else if (t.dataset.tab) {
      $$(".tab").forEach((b) => b.setAttribute("aria-selected", String(b === t)));
      ["gaps", "all", "file"].forEach((k) => ($(`#tab-${k}`).hidden = k !== t.dataset.tab));
    }
    else if (t.dataset.dom) {
      const sid = t.dataset.dom;
      const on = state.gapFilter === sid ? null : sid;
      state.gapFilter = on;
      $$(".dom").forEach((b) => b.classList.toggle("on", b.dataset.dom === on));
      state.resMosaic.highlight(on ? state.result.controls.filter((c) => c.sub === on).map((c) => c.id) : null);
      renderGaps();
      $$(".tab")[0].click();
    }
    else if (t.hasAttribute("data-clear-dom")) {
      state.gapFilter = null;
      $$(".dom").forEach((b) => b.classList.remove("on"));
      state.resMosaic.highlight(null);
      renderGaps();
    }
    else if (t.dataset.kpi) {
      state.allFilter = state.allFilter === t.dataset.kpi ? null : t.dataset.kpi;
      $$(".kpi").forEach((b) => b.classList.toggle("on", b.dataset.kpi === state.allFilter));
      renderAll();
      $$(".tab")[1].click();
      $(".tabs").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
    else if ("all" in t.dataset) { state.allFilter = t.dataset.all || null; renderAll(); }
    else if (t.dataset.open) openControl(t.dataset.open);
    else if (t.dataset.explain) explain(t.dataset.explain, t);
    else if (t.dataset.copy) {
      const [cid, i] = t.dataset.copy.split(":");
      const f = state.result.controls.find((c) => c.id === cid).fixes[+i];
      try { await navigator.clipboard.writeText(f.text); toast("نسخنا البند"); }
      catch { toast("ما قدرنا ننسخ. حدد النص وانسخه يدويًا.", true); }
    }
    else if ("close" in t.dataset) closeDrawer();
  });
  $(".drawer-scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  document.addEventListener("input", (e) => {
    if (e.target.id === "q") {
      state.query = e.target.value;
      const pos = e.target.selectionStart;
      renderAll();
      const q = $("#q");
      q.focus();
      q.setSelectionRange(pos, pos);
    }
  });
  $("#setup-form").addEventListener("submit", submitSetup);
  const drop = $("#drop");
  $("#file-input").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));
}

async function init() {
  document.documentElement.classList.add("js");
  fillIcons();
  bind();
  mountFx();
  bindTilt();
  bindReveal();
  try {
    state.meta = await api("/api/meta");
  } catch (e) {
    document.body.insertAdjacentHTML("afterbegin", `<p class="mode-note" style="margin:12px">الخادم المحلي لا يستجيب. شغّله بالأمر: python -m deraa.web</p>`);
    return;
  }
  await checkHealth();
  setInterval(checkHealth, 20000);
  route();
}
init();
