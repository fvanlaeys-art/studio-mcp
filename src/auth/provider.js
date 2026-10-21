import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

// Minimal single-tenant OAuth provider: there is no real login screen because
// this server has exactly one owner (whoever controls the machine it runs on
// and the claude.ai account that connects to it). Authorization is granted
// automatically; the OAuth dance exists only so claude.ai's custom-connector
// flow (which expects RFC 7591 dynamic client registration + PKCE) succeeds.

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24h, refreshed via refresh_token

// Persisted to disk so a server restart (routine while iterating) doesn't
// force claude.ai to redo the connector handshake every time.
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".oauth-state.json");

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      clients: new Map(raw.clients || []),
      tokens: new Map(raw.tokens || []),
      refreshTokens: new Map(raw.refreshTokens || []),
    };
  } catch {
    return { clients: new Map(), tokens: new Map(), refreshTokens: new Map() };
  }
}

const { clients, tokens, refreshTokens } = loadState();
const codes = new Map(); // code -> { clientId, redirectUri, codeChallenge, scopes, expiresAt } — short-lived, no need to persist

function saveState() {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        clients: [...clients],
        tokens: [...tokens],
        refreshTokens: [...refreshTokens],
      }),
    );
  } catch (e) {
    console.error("Impossible d'enregistrer l'état OAuth sur disque :", e.message);
  }
}

function newToken() {
  return randomBytes(32).toString("hex");
}

export const studioAuthProvider = {
  clientsStore: {
    getClient(clientId) {
      return clients.get(clientId);
    },
    registerClient(client) {
      clients.set(client.client_id, client);
      saveState();
      return client;
    },
  },

  async authorize(client, params, res) {
    const code = randomUUID();
    codes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes || [],
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const entry = codes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code is invalid or expired");
    }
    return entry.codeChallenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode) {
    const entry = codes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code is invalid or expired");
    }
    codes.delete(authorizationCode);

    const access_token = newToken();
    const refresh_token = newToken();
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    tokens.set(access_token, { clientId: client.client_id, scopes: entry.scopes, expiresAt });
    refreshTokens.set(refresh_token, { clientId: client.client_id, scopes: entry.scopes });
    saveState();

    return {
      access_token,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token,
      scope: entry.scopes.join(" ") || undefined,
    };
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const entry = refreshTokens.get(refreshToken);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token is invalid or unknown");
    }
    const access_token = newToken();
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    const grantedScopes = scopes || entry.scopes;
    tokens.set(access_token, { clientId: client.client_id, scopes: grantedScopes, expiresAt });
    saveState();
    return {
      access_token,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: grantedScopes.join(" ") || undefined,
    };
  },

  async verifyAccessToken(token) {
    const entry = tokens.get(token);
    if (!entry) throw new InvalidTokenError("Token is invalid or unknown");
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      tokens.delete(token);
      throw new InvalidTokenError("Token has expired");
    }
    return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt };
  },
};
