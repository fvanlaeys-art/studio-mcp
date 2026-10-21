const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

const DEFAULT_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium";

export async function generateImage({ prompt, size, quality, referenceImages }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquante dans .env");
  const q = quality || DEFAULT_QUALITY;

  let response;
  if (referenceImages?.length) {
    const form = new FormData();
    form.append("model", IMAGE_MODEL);
    form.append("prompt", prompt);
    if (size) form.append("size", size);
    form.append("quality", q);
    referenceImages.forEach((b64, i) => {
      const buf = Buffer.from(b64, "base64");
      form.append("image[]", new Blob([buf], { type: "image/png" }), `ref-${i}.png`);
    });
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: size || "1024x1024", quality: q, n: 1 }),
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI image API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Réponse OpenAI inattendue : pas d'image b64_json dans la réponse.");
  return { base64: b64, mimeType: "image/png" };
}
