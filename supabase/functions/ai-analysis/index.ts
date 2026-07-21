import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// "latest" aliases selalu diarahkan Google ke model flash yang sedang didukung,
// jadi tidak basi saat versi bertanggal (mis. gemini-2.5-flash) dihentikan.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function callGemini(model: string, prompt: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
    }),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!GEMINI_API_KEY) {
    return jsonResponse({ error: "GEMINI_API_KEY belum diset sebagai secret di Supabase." }, 500);
  }

  let prompt: unknown;
  try {
    const body = await req.json();
    prompt = body?.prompt;
  } catch {
    return jsonResponse({ error: "Body request harus JSON dengan field 'prompt'." }, 400);
  }

  if (!prompt || typeof prompt !== "string") {
    return jsonResponse({ error: "Field 'prompt' wajib diisi dan berupa string." }, 400);
  }

  let lastError: { status: number; message: string } | null = null;

  // Coba semua model cadangan secara berurutan sebelum benar-benar menyerah.
  for (const model of GEMINI_MODELS) {
    try {
      const { ok, status, data } = await callGemini(model, prompt);

      if (ok) {
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map((p: { text?: string }) => p.text || "")
          .join("");
        if (text) return jsonResponse({ text, model });
        lastError = { status: 502, message: "Gemini tidak mengembalikan jawaban (mungkin diblokir safety filter)." };
        continue;
      }

      lastError = { status, message: data?.error?.message || "Gagal memanggil Gemini API." };
      // 400 = prompt/request bermasalah (bukan soal model) -> tidak akan beda hasil di model lain.
      if (status === 400) break;
    } catch (err) {
      lastError = { status: 500, message: String(err) };
    }
  }

  return jsonResponse({ error: lastError?.message || "Semua model Gemini gagal dipanggil." }, lastError?.status || 500);
});
