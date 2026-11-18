/* نسخة عرض درع على الويب: بدون خادم ولا نموذج.
   نرد على طلبات /api من بيانات العرض التجريبي المحفوظة (شركة نخلة الوهمية)، والباقي يعمل في النسخة المحلية بس. */
window.DERAA_STATIC = true;
(() => {
  const realFetch = window.fetch.bind(window);
  const cache = {};
  const load = (name) => cache[name] || (cache[name] = realFetch(`data/${name}.json`).then((r) => r.json()));
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const LOCAL = "هذه نسخة عرض على الويب: رفع الملفات وتحليلها وشرح النموذج تعمل في النسخة المحلية على جهاز المنشأة، لأن النموذج يعمل هناك.";
  window.fetch = async (url, opts = {}) => {
    if (typeof url !== "string" || !url.startsWith("/api/")) return realFetch(url, opts);
    const [path, query] = url.split("?");
    const since = +(new URLSearchParams(query || "").get("since") || 0);
    if (path === "/api/health") return json({ ollama: false, model_ready: false, model: "qwen3.5:9b", message: LOCAL });
    if (path === "/api/meta") return json(await load("meta"));
    if (path === "/api/demo") return json({ job: "demo" });
    if (path === "/api/upload" || path === "/api/analyze") return json({ error: LOCAL }, 400);
    const m = path.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/);
    if (!m || m[1] !== "demo") return json({ error: "هذا الفحص غير موجود في نسخة العرض. جرّب العرض التجريبي." }, 404);
    if (!m[2]) { const p = await load("progress"); return json({ ...p, events: p.events.slice(since), next: p.events.length }); }
    if (m[2] === "/result") return json(await load("result"));
    return json({ error: LOCAL }, 400);
  };
  // السكربت في آخر الصفحة، فالرأس موجود: نضيف الشريط قبل ما يبدأ app.js (عشان تتعبى الأيقونة)
  {
    const top = document.querySelector("header.top");
    if (top) top.insertAdjacentHTML("afterend", `<div class="demo-ribbon"><div class="wrap"><span data-icon="spark"></span>
      <span>نسخة عرض على الويب. شاهد فحصًا كاملًا على شركة وهمية، والتحليل الحقيقي يعمل على جهاز المنشأة فقط.</span>
      <button type="button" data-action="demo">شاهد العرض التجريبي</button></div></div>`);
  }
})();
