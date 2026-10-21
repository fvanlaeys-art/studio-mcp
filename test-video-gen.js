import "dotenv/config";
import { writeFileSync } from "node:fs";
import { startVideo, checkVideo } from "./src/providers/geminiVideo.js";

const prompt = [
  "Dans un seul plan séquence continu, sans coupure de scène :",
  "Un diagnostiqueur immobilier filme en POV son smartphone qu'il tient devant lui dans une pièce vide en cours de rénovation, lumière naturelle, il parle doucement en dictant un relevé.",
  "Son : voix masculine calme qui dicte 'Chambre un, premier étage, menuiserie PVC double vitrage'. Pas de musique, pas de dialogue superflu.",
].join(" ");

console.log("Lancement...");
const { fileId } = await startVideo({ prompt, aspectRatio: "9:16", resolution: "720p" });
console.log("fileId:", fileId);

let result;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 8000));
  result = await checkVideo({ fileId });
  console.log(`[${i}] state:`, result.state);
  if (result.state !== "processing") break;
}

if (result.state === "active") {
  writeFileSync("./test-video-output.mp4", Buffer.from(result.base64, "base64"));
  console.log("OK ->", "./test-video-output.mp4");
} else {
  console.log("Résultat final:", result);
}
