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
  const url = new URL(requestUrl);
  assert.equal(url.pathname, "/_turn/voice%20demo");
  assert.equal(url.searchParams.get("webrtc"), "1");
  assert.equal(url.searchParams.get("expire"), "90");
  assert.equal(url.searchParams.get("geo"), "1");
  assert.equal(requestInit?.method, "PUT");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { user_ip: "8.8.8.8" });
  const headers = requestInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from("ident:secret").toString("base64")}`);
  assert.equal(headers["Content-Type"], "application/json");
});

test("XirsysClient requests the standard WebRTC array without geo by default", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = createClient((async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json({
      s: "ok",
      v: { iceServers: [{ urls: "stun:turn.example" }] },
    });
  }) as typeof fetch);

  const servers = await client.getIceServers();

  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.urls, "stun:turn.example");
  const url = new URL(requestUrl);
  assert.equal(url.searchParams.get("webrtc"), "1");
  assert.equal(url.searchParams.has("geo"), false);
  assert.equal(requestInit?.body, undefined);
  assert.equal(
    (requestInit?.headers as Record<string, string>)["Content-Type"],
    undefined,
  );
});

test("XirsysClient rejects non-public geo hints before calling Xirsys", async () => {
  const client = createClient((async () => {
    throw new Error("fetch should not be called");
  }) as typeof fetch);

  await assert.rejects(
    () => client.getIceServers({ userIp: "192.168.1.10" }),
    /valid public IPv4 or IPv6 address/,
  );
  await assert.rejects(
    () => client.getIceServers({ userIp: "0:0:0:0:0:0:0:1" }),
    /valid public IPv4 or IPv6 address/,
  );
  await assert.rejects(
    () => client.getIceServers({ userIp: "::ffff:192.168.1.10" }),
    /valid public IPv4 or IPv6 address/,
  );
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
