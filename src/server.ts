import "dotenv/config";

import express, { type ErrorRequestHandler, type Request } from "express";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OpenAIRealtimeClient,
  UpstreamApiError,
  XirsysClient,
  type RealtimeSessionConfig,
} from "./sdk/index.js";

const app = express();
const port = parseInteger(process.env.PORT, 3000);
const host = process.env.HOST ?? "0.0.0.0";
const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const publicOrigin = normalizeOrigin(process.env.PUBLIC_ORIGIN);
const bootstrapRateLimit = createRateLimiter({
  maxRequests: parseInteger(process.env.BOOTSTRAP_RATE_LIMIT_MAX, 10),
  windowMs: parseInteger(process.env.BOOTSTRAP_RATE_LIMIT_WINDOW_MS, 60_000),
});

if (process.env.TRUST_PROXY === "true") {
  // Configure the exact proxy hop count or subnet in production.
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.static(publicDirectory));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post(
  "/api/bootstrap",
  disableCredentialCaching,
  enforcePublicOrigin,
  bootstrapRateLimit,
  async (request, response, next) => {
    try {
      const openaiApiKey = readOpenAIApiKey(request);
      const openai = new OpenAIRealtimeClient({ apiKey: openaiApiKey });
      const xirsys = createXirsysClient();
      const includeSignaling = request.body?.includeSignaling === true;
      const peerId = request.body?.peerId;

      if (includeSignaling && typeof peerId !== "string") {
        response.status(400).json({ error: "peerId is required when signaling is enabled" });
        return;
      }

      const session: RealtimeSessionConfig = {
        type: "realtime",
        model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
        instructions:
          process.env.OPENAI_REALTIME_INSTRUCTIONS ??
          "You are a concise, friendly voice assistant. Answer naturally and briefly.",
        audio: {
          output: {
            voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
          },
        },
      };

      const trustedPublicIp =
        process.env.XIRSYS_GEO === "true" ? getTrustedPublicIp(request) : undefined;
      const iceTtl = parseInteger(process.env.XIRSYS_ICE_TTL_SECONDS, 60);

      const [clientSecret, iceServers, signaling] = await Promise.all([
        openai.createClientSecret({ session }),
        xirsys.getIceServers({
          expiresInSeconds: iceTtl,
          ...(trustedPublicIp ? { userIp: trustedPublicIp } : {}),
        }),
        includeSignaling
          ? xirsys.getSignalingCredentials({ peerId, expiresInSeconds: 120 })
          : Promise.resolve(undefined),
      ]);

      response.json({
        clientSecret: {
          value: clientSecret.value,
          ...(clientSecret.expires_at ? { expiresAt: clientSecret.expires_at } : {}),
        },
        iceServers,
        session: {
          model: session.model,
          voice: session.audio?.output?.voice,
        },
        ...(signaling ? { signaling } : {}),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("*splat", (_request, response) => {
  response.sendFile(path.join(publicDirectory, "index.html"));
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof UpstreamApiError) {
    console.error(`${error.service} request failed`, {
      status: error.status,
      message: error.message,
    });
    response.status(502).json({ error: error.message, service: error.service });
    return;
  }

  if (error instanceof TypeError || error instanceof RangeError) {
    response.status(400).json({ error: error.message });
    return;
  }

  console.error("Unexpected server error", error);
  response.status(500).json({ error: "Unexpected server error" });
};

app.use(errorHandler);

if (process.env.NODE_ENV !== "test") {
  app.listen(port, host, () => {
    console.log(`OpenAI Realtime + Xirsys tutorial: http://${host}:${port}`);
  });
}

export { app };

function createXirsysClient(): XirsysClient {
  return new XirsysClient({
    ident: requireEnvironment("XIRSYS_IDENT"),
    secret: requireEnvironment("XIRSYS_SECRET"),
    channel: requireEnvironment("XIRSYS_CHANNEL"),
    baseUrl: process.env.XIRSYS_API_BASE ?? "https://global.xirsys.net",
  });
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new TypeError(`Missing required environment variable: ${name}`);
  return value;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("PUBLIC_ORIGIN must contain only a scheme and host");
  }
  return url.origin;
}

function readOpenAIApiKey(request: Request): string {
  const value = request.body?.openaiApiKey;
  if (
    typeof value !== "string" ||
    !value.startsWith("sk-") ||
    value.length < 20 ||
    value.length > 512 ||
    /\s/.test(value)
  ) {
    throw new TypeError("A valid OpenAI API key is required");
  }
  return value;
}

function disableCredentialCaching(
  _request: Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
  next();
}

function enforcePublicOrigin(
  request: Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (!publicOrigin) {
    next();
    return;
  }

  const requestOrigin = request.get("Origin");
  if (requestOrigin !== publicOrigin) {
    response.status(403).json({ error: "Request origin is not allowed" });
    return;
  }

  next();
}

function createRateLimiter({
  maxRequests,
  windowMs,
}: {
  maxRequests: number;
  windowMs: number;
}): express.RequestHandler {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || "unknown";
    let bucket = attempts.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      attempts.set(key, bucket);
    }

    response.set("X-RateLimit-Limit", String(maxRequests));
    response.set("X-RateLimit-Remaining", String(Math.max(0, maxRequests - bucket.count - 1)));
    response.set("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1_000)));

    if (bucket.count >= maxRequests) {
      response.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))));
      response.status(429).json({ error: "Too many bootstrap requests; try again shortly" });
      return;
    }

    bucket.count += 1;

    if (attempts.size > 10_000) {
      for (const [candidateKey, candidate] of attempts) {
        if (candidate.resetAt <= now) attempts.delete(candidateKey);
      }
    }

    next();
  };
}

function getTrustedPublicIp(request: Request): string | undefined {
  const value = request.ip?.replace(/^::ffff:/, "");
  if (!value || !isPublicIp(value)) return undefined;
  return value;
}

function isPublicIp(value: string): boolean {
  const version = isIP(value);
  if (version === 4) {
    const parts = value.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }

  if (version === 6) {
    const normalized = value.toLowerCase();
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("2001:db8:")
    );
  }

  return false;
}
