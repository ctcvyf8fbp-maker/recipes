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
    if (req.method === "GET") return out(200, { ok: true, ready: !!env.GEMINI_KEY });
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
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: payload,
      });
      if (r.ok) {
        const j = await r.json();
        const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
          .map(p => p.text || "").join("");
        return text ? out(200, { text, model }) : out(502, { code: "refused" });
      }
      lastStatus = r.status;
      if (![400, 404, 429, 500, 503].includes(r.status)) break;
    }
    return out(lastStatus === 429 ? 429 : 502, { code: lastStatus === 429 ? "rate_limited" : "upstream_error" });
  },
};
