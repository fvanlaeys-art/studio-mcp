const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "gemini-omni-1.1-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

function requireKey() {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY manquante dans .env");
}

// Kicks off generation and returns immediately with a file reference that is
// still processing — video generation takes too long to wait on in one call.
export async function startVideo({ prompt, aspectRatio, resolution, referenceImages }) {
  requireKey();

  const input = referenceImages?.length
    ? [
        { type: "text", text: prompt },
        ...referenceImages.map((b64) => ({ type: "image", mime_type: "image/png", data: b64 })),
      ]
    : prompt;

  const body = {
    model: VIDEO_MODEL,
    input,
    response_format: {
      type: "video",
      delivery: "uri",
      resolution: resolution || "720p",
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    },
  };

  const response = await fetch(`${BASE}/interactions?key=${GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini video API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const uri = data?.output_video?.uri || data?.steps?.find((s) => s.type === "model_output")?.content?.[0]?.uri;
  if (!uri) throw new Error("Réponse Gemini inattendue : pas d'URI vidéo dans la réponse.");

  const fileId = uri.split("/files/")[1]?.split(":")[0]?.split("?")[0];
  if (!fileId) throw new Error(`Impossible d'extraire le fileId de l'URI : ${uri}`);

  return { fileId };
}

// Poll this until state is "active" (ready, call again to download) or "failed".
export async function checkVideo({ fileId }) {
  requireKey();

  const response = await fetch(`${BASE}/files/${fileId}?key=${GOOGLE_API_KEY}`);
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini files API error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const state = (data.state || "").toUpperCase();

  if (state === "FAILED") {
    return { state: "failed", error: data.error?.message || "Génération échouée." };
  }
  if (state !== "ACTIVE") {
    return { state: "processing" };
  }

  const dl = await fetch(`${BASE}/files/${fileId}:download?alt=media&key=${GOOGLE_API_KEY}`);
  if (!dl.ok) {
    const errText = await dl.text();
    throw new Error(`Gemini download error (${dl.status}): ${errText}`);
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  return { state: "active", base64: buf.toString("base64"), mimeType: "video/mp4" };
}
