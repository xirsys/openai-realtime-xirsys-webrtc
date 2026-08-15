import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

test("the bootstrap endpoint requires and transiently uses a tester API key", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.PUBLIC_ORIGIN = "";
  process.env.TRUST_PROXY = "true";
  process.env.XIRSYS_GEO = "true";
  process.env.XIRSYS_IDENT = "test-ident";
  process.env.XIRSYS_SECRET = "test-secret";
  process.env.XIRSYS_CHANNEL = "test-channel";
  process.env.XIRSYS_API_BASE = "https://xirsys.example";
  process.env.BOOTSTRAP_RATE_LIMIT_MAX = "10";
  process.env.BOOTSTRAP_RATE_LIMIT_WINDOW_MS = "60000";

  const nativeFetch = globalThis.fetch;
  const { app } = await import("../src/server.js");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/bootstrap`;

  const missingKey = await nativeFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missingKey.json(), {
    error: "A valid OpenAI API key is required",
  });

  const testerKey = "sk-proj-test-key-that-is-long-enough";
  let authorization = "";
  let turnRequestUrl = "";
  let turnRequestInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/realtime/client_secrets") {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Response.json({ value: "ek_test", expires_at: 12345 });
    }
    if (url.startsWith("https://xirsys.example/_turn/")) {
      turnRequestUrl = url;
      turnRequestInit = init;
      return Response.json({
        s: "ok",
        v: { iceServers: [{ urls: ["stun:turn.example"] }] },
      });
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });

  const response = await nativeFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": "8.8.8.8",
    },
    body: JSON.stringify({ openaiApiKey: testerKey }),
  });
  const responseText = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(authorization, `Bearer ${testerKey}`);
  assert.equal(responseText.includes(testerKey), false);
  const body = JSON.parse(responseText);
  assert.equal(body.clientSecret.value, "ek_test");
  assert.equal(body.iceServers.length, 1);
  const turnUrl = new URL(turnRequestUrl);
  assert.equal(turnUrl.searchParams.get("webrtc"), "1");
  assert.equal(turnUrl.searchParams.get("geo"), "1");
  assert.deepEqual(JSON.parse(String(turnRequestInit?.body)), { user_ip: "8.8.8.8" });
});
