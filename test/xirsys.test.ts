import assert from "node:assert/strict";
import test from "node:test";

import { XirsysClient } from "../src/sdk/index.js";

test("XirsysClient returns WebRTC ICE servers and sends geo hints securely", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json({
      s: "ok",
      v: {
        iceServers: [
          {
            username: "temporary-user",
            credential: "temporary-secret",
            urls: ["stun:turn.example", "turns:turn.example:443?transport=tcp"],
          },
        ],
      },
    });
  }) as typeof fetch;

  const client = createClient(mockFetch);
  const servers = await client.getIceServers({
    expiresInSeconds: 90,
    userIp: "8.8.8.8",
  });

  assert.equal(servers[0]?.username, "temporary-user");
  assert.match(requestUrl, /\/_turn\/voice%20demo\?/);
  assert.match(requestUrl, /webrtc=1/);
  assert.match(requestUrl, /expire=90/);
  assert.match(requestUrl, /geo=1/);
  assert.equal(requestInit?.method, "PUT");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { user_ip: "8.8.8.8" });
  const headers = requestInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from("ident:secret").toString("base64")}`);
});

test("XirsysClient creates an encoded Signaling V2 WebSocket URL", async () => {
  const mockFetch = (async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes("/_host")) {
      return Response.json({ s: "ok", v: "wss://signal.example/ws/" });
    }
    return Response.json({ s: "ok", v: "short/token+value" });
  }) as typeof fetch;

  const client = createClient(mockFetch);
  const signaling = await client.getSignalingCredentials({
    peerId: "browser-123",
    expiresInSeconds: 120,
  });

  assert.equal(
    signaling.url,
    "wss://signal.example/ws/v2/short%2Ftoken%2Bvalue",
  );
  assert.equal(signaling.peerId, "browser-123");
});

test("XirsysClient rejects unsafe peer IDs before calling Xirsys", async () => {
  const client = createClient((async () => {
    throw new Error("fetch should not be called");
  }) as typeof fetch);

  await assert.rejects(
    () => client.getSignalingCredentials({ peerId: "not/a/peer" }),
    /peerId must be/,
  );
});

function createClient(fetchImplementation: typeof fetch): XirsysClient {
  return new XirsysClient({
    ident: "ident",
    secret: "secret",
    channel: "voice demo",
    baseUrl: "https://xirsys.example/",
    fetch: fetchImplementation,
  });
}
