// השף של ספר המתכונים: שרת קטן ב-Cloudflare שמחבר את האתר ל-Gemini.
// המפתח של Gemini שמור כסוד (GEMINI_KEY) ב-Cloudflare, ולא מופיע באתר.

// רק האתר הזה יכול להשתמש בשף:
const ALLOWED = ["https://ctcvyf8fbp-maker.github.io"];

// המודלים לפי סדר עדיפות. אם אחד לא זמין או שהמכסה שלו נגמרה, עוברים לבא.
const MODELS = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const ok = ALLOWED.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": ok ? origin : ALLOWED[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const out = (status, obj) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("test") !== "1") return out(200, { ok: true, ready: !!env.GEMINI_KEY });
      // עמוד בדיקה: שולח שאלה קטנה לכל מודל ומראה מה גוגל עונים
      if (!env.GEMINI_KEY) return out(200, { ready: false, problem: "GEMINI_KEY חסר" });
      const k = env.GEMINI_KEY.trim();
      const results = [];
      for (const model of (env.MODEL ? [env.MODEL] : MODELS)) {
        const r = await callGemini(k, model, JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the word ok" }] }] }));
        let message = "";
        try { const j = await r.json(); message = r.ok ? "עובד" : ((j.error && (j.error.status + ": " + j.error.message)) || ""); } catch {}
        results.push({ model, status: r.status, message: message.slice(0, 300) });
      }
      return out(200, { ready: true, keyStart: k.slice(0, 4), keyLength: k.length, results });
    }
    if (!ok) return out(403, { code: "forbidden" });
    if (req.method !== "POST") return out(405, { code: "method" });
    if (!env.GEMINI_KEY) return out(500, { code: "no_key" });
    if ((+req.headers.get("Content-Length") || 0) > 8_000_000) return out(413, { code: "too_large" });

    let body;
    try { body = await req.json(); } catch { return out(400, { code: "bad_request" }); }

    // הודעות השיחה (מאחדים הודעות רצופות של אותו צד, כפי ש-Gemini מצפה)
    const contents = [];
    for (const m of (Array.isArray(body.messages) ? body.messages.slice(-12) : [])) {
      const role = m && m.role === "assistant" ? "model" : "user";
      const text = String((m && m.content) || "").slice(0, 20000);
      if (!text) continue;
      const prev = contents[contents.length - 1];
      if (prev && prev.role === role) prev.parts[0].text += "\n\n" + text;
      else contents.push({ role, parts: [{ text }] });
    }
    if (!contents.length || contents[contents.length - 1].role !== "user") return out(400, { code: "bad_request" });

    // צילומי מסך מצורפים להודעה האחרונה
    const last = contents[contents.length - 1];
    for (const im of (Array.isArray(body.images) ? body.images.slice(0, 4) : [])) {
      if (im && /^image\/(png|jpeg|webp)$/.test(im.mime) && typeof im.data === "string" && im.data.length < 3_000_000)
        last.parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
    }

    const payload = JSON.stringify({ contents, generationConfig: { responseMimeType: "application/json", temperature: 0.8 } });
    const models = env.MODEL ? [env.MODEL] : MODELS;
    let lastStatus = 502;
    for (const model of models) {
      const r = await callGemini(env.GEMINI_KEY.trim(), model, payload);
      if (r.ok) {
        const j = await r.json();
        const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
          .map(p => p.text || "").join("");
        return text ? out(200, { text, model }) : out(502, { code: "refused" });
      }
      lastStatus = r.status;
      if (![400, 404, 429, 500, 503].includes(r.status)) break;
    }
    return out(lastStatus === 429 ? 429 : 502, { code: lastStatus === 429 ? "rate_limited" : "upstream_error", status: lastStatus });
  },
};

// פנייה ל-Gemini. אם המפתח נדחה בכותרת, מנסים שוב בדרך החלופית (מפתח בכתובת).
async function callGemini(key, model, payload) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let r = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: payload });
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    const r2 = await fetch(base + "?key=" + encodeURIComponent(key), { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    if (r2.ok || r2.status === 429) return r2;
  }
  return r;
}
