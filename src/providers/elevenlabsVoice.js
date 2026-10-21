const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel, voix par défaut ElevenLabs
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

export async function generateVoice({ text, voiceId }) {
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY manquante dans .env");
  const id = voiceId || DEFAULT_VOICE_ID;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({ text, model_id: MODEL_ID }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errText}`);
  }

  const buf = Buffer.from(await response.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: "audio/mpeg" };
}

export async function listVoices() {
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY manquante dans .env");
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });
  if (!response.ok) throw new Error(`ElevenLabs API error (${response.status})`);
  const data = await response.json();
  return (data.voices || []).map((v) => ({ id: v.voice_id, name: v.name }));
}
