import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { z } from "zod";
import { generateImage } from "./providers/openaiImage.js";
import { generateVoice, listVoices } from "./providers/elevenlabsVoice.js";
import { startVideo, checkVideo } from "./providers/geminiVideo.js";
import { studioAuthProvider } from "./auth/provider.js";

const PORT = process.env.PORT || 8787;
const PUBLIC_URL = process.env.PUBLIC_URL;
if (!PUBLIC_URL) {
  console.error("PUBLIC_URL manquante dans .env (l'URL https publique du tunnel, ex: https://xxx.ngrok-free.dev)");
  process.exit(1);
}
const issuerUrl = new URL(PUBLIC_URL);
const resourceUrl = new URL("/mcp", PUBLIC_URL);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

// Keeps the relay (Anthropic's MCP proxy, which gives up on a silent
// connection well before a slow image/video generation finishes) convinced
// the call is still alive, by pinging notifications/progress every few
// seconds. Only sends anything if the caller opted in with a progressToken.
async function withProgress(extra, fn) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return fn();
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, total: 100 },
    }).catch(() => {});
  }, 8000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function buildServer() {
  const server = new McpServer({ name: "studio-mcp", version: "0.1.0" });

  server.registerTool(
    "generate_image",
    {
      title: "Générer une image publicitaire",
      description:
        "Génère une créa statique (image) à partir d'un prompt texte, avec jusqu'à 4 images de référence optionnelles (produit, charte graphique). Retourne l'image en PNG.",
      inputSchema: {
        prompt: z.string().min(1).describe("Description détaillée du visuel à générer."),
        size: z
          .enum(["1024x1024", "1024x1536", "1536x1024"])
          .optional()
          .describe("Dimensions de l'image."),
        quality: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Qualité/coût : low (~0,006 $), medium (~0,05 $), high (~0,21 $). Par défaut : medium."),
        referenceImages: z
          .array(z.string())
          .max(4)
          .optional()
          .describe("Images de référence encodées en base64 (sans préfixe data:)."),
      },
    },
    async ({ prompt, size, quality, referenceImages }, extra) => {
      const { base64, mimeType } = await withProgress(extra, () =>
        generateImage({ prompt, size, quality, referenceImages }),
      );
      return {
        content: [
          { type: "image", data: base64, mimeType },
          { type: "text", text: "Image générée avec succès." },
        ],
      };
    },
  );

  server.registerTool(
    "generate_voice",
    {
      title: "Générer une voix-off",
      description: "Convertit un texte en voix-off (audio MP3) via ElevenLabs.",
      inputSchema: {
        text: z.string().min(1).describe("Le texte à lire."),
        voiceId: z
          .string()
          .optional()
          .describe("Identifiant de la voix ElevenLabs. Par défaut, la voix configurée côté serveur."),
      },
    },
    async ({ text, voiceId }, extra) => {
      const { base64, mimeType } = await withProgress(extra, () => generateVoice({ text, voiceId }));
      return {
        content: [
          { type: "audio", data: base64, mimeType },
          { type: "text", text: "Voix-off générée avec succès." },
        ],
      };
    },
  );

  server.registerTool(
    "list_voices",
    {
      title: "Lister les voix ElevenLabs disponibles",
      description: "Retourne la liste des voix ElevenLabs disponibles sur le compte configuré (id et nom).",
      inputSchema: {},
    },
    async () => {
      const voices = await listVoices();
      return { content: [{ type: "text", text: JSON.stringify(voices, null, 2) }] };
    },
  );

  server.registerTool(
    "generate_video_start",
    {
      title: "Lancer une génération vidéo",
      description:
        "Lance la génération d'une créa vidéo (image + son natif) via Gemini Omni Flash. Ne retourne pas la vidéo : répond vite avec un fileId, à repasser à generate_video_status pour suivre l'avancement et récupérer le résultat (la génération prend 1 à quelques minutes).",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe(
            "Description détaillée de la vidéo : scène, mouvement de caméra, éclairage, ambiance, ambiance sonore. Préciser 'une seule scène continue' pour éviter les coupures multi-plans.",
          ),
        aspectRatio: z.enum(["16:9", "9:16"]).optional().describe("16:9 (paysage, défaut) ou 9:16 (portrait, stories/reels)."),
        resolution: z.enum(["360p", "720p", "1080p", "4k"]).optional().describe("Par défaut 720p."),
        referenceImages: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("Jusqu'à 3 images de référence en base64 (produit, personnage, charte graphique)."),
      },
    },
    async ({ prompt, aspectRatio, resolution, referenceImages }) => {
      const { fileId } = await startVideo({ prompt, aspectRatio, resolution, referenceImages });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ fileId, message: "Génération lancée. Interroge generate_video_status avec ce fileId dans quelques secondes." }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "generate_video_status",
    {
      title: "Vérifier/récupérer une génération vidéo",
      description:
        "Interroge l'avancement d'une génération lancée par generate_video_start. Retourne processing (réessayer dans 5-10s), failed (avec l'erreur), ou active avec la vidéo en MP4.",
      inputSchema: {
        fileId: z.string().min(1).describe("Le fileId retourné par generate_video_start."),
      },
    },
    async ({ fileId }, extra) => {
      const result = await withProgress(extra, () => checkVideo({ fileId }));
      if (result.state === "active") {
        // "video" isn't a content type the MCP spec defines (only
        // text/image/audio/resource/resource_link) — the SDK's own result
        // validation rejects it. Binary video goes in an embedded resource.
        return {
          content: [
            {
              type: "resource",
              resource: { uri: `studio-video://${fileId}`, mimeType: result.mimeType, blob: result.base64 },
            },
            { type: "text", text: "Vidéo générée avec succès." },
          ],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}

const app = express();
app.set("trust proxy", 1); // behind ngrok: needed for express-rate-limit to read X-Forwarded-For correctly

app.use(
  mcpAuthRouter({
    provider: studioAuthProvider,
    issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: ["mcp"],
  }),
);

const requireAuth = requireBearerAuth({ verifier: studioAuthProvider, resourceMetadataUrl });

const transports = new Map();

app.post("/mcp", express.json({ limit: "25mb" }), requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports.has(sessionId)) {
    transport = transports.get(sessionId);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const server = buildServer();
    await server.connect(transport);
  } else if (sessionId) {
    // A session id was given but this process doesn't know it (e.g. the
    // server restarted since it was issued). 404 is the signal well-behaved
    // MCP clients use to start a fresh session, instead of giving up.
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });
    return;
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session MCP invalide ou manquante." },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId) {
    res.status(400).send("Session MCP invalide ou manquante.");
    return;
  }
  if (!transports.has(sessionId)) {
    res.status(404).send("Session not found");
    return;
  }
  const transport = transports.get(sessionId);
  await transport.handleRequest(req, res);
}

app.get("/mcp", requireAuth, handleSessionRequest);
app.delete("/mcp", requireAuth, handleSessionRequest);

app.get("/health", (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`studio-mcp en écoute sur http://localhost:${PORT}/mcp`);
});

// Node's default keep-alive timeout (5s) is shorter than the idle gaps a
// reverse proxy (Anthropic's MCP relay, ngrok) can leave between requests on
// a reused connection. If we close the socket first, the proxy's next
// request on it looks like "connection lost" even though nothing crashed.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000; // must be greater than keepAliveTimeout
