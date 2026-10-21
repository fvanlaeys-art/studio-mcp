import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { generateImage } from "./src/providers/openaiImage.js";

const logoB64 = readFileSync("./auditoo-logo.png").toString("base64");

const prompt = [
  "Visuel publicitaire Meta au format 4:5 pour Auditoo, application mobile qui permet aux diagnostiqueurs immobiliers de dicter leurs relevés à la voix sur le terrain (descriptifs, métrés, photos annotées), avec structuration automatique par IA et export vers leur logiciel métier.",
  "Utilise EXACTEMENT le logo fourni en référence (wordmark 'auditoo' en minuscules, sans icône) sans le modifier ni le réinventer — reproduis-le tel quel, à l'identique, en haut du visuel.",
  "Charte graphique à respecter strictement : fond crème/beige clair (#FAF8F3), texte en noir profond légèrement verdâtre (#1A1F1C), accent en vert forêt profond (#033527) pour les éléments de mise en avant (bouton, chiffres clés). Pas de vert vif, pas de bleu, pas d'icône de coche circulaire.",
  'Accroche à intégrer visuellement : "Dictez vos diagnostics, l\'IA fait le reste."',
  "Inclure ces 3 vrais chiffres clés du site Auditoo, affichés clairement (façon stat/badge) : « +200 entreprises de diagnostic » / « -50% de temps de traitement » / « -30% d'erreurs de saisie ».",
  "Visuel : un diagnostiqueur sur le terrain avec son smartphone, en train de dicter/photographier dans un logement en cours de visite (pas un bureau), style photo réaliste et professionnelle, lumière naturelle.",
].join(" ");

console.log("Génération en cours...");
const { base64, mimeType } = await generateImage({
  prompt,
  size: "1024x1536",
  quality: "medium",
  referenceImages: [logoB64],
});

writeFileSync("./test-output.png", Buffer.from(base64, "base64"));
console.log("OK, mimeType:", mimeType, "-> ./test-output.png");
