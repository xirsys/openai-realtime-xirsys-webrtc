import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIRealtimeClient, UpstreamApiError } from "../src/sdk/index.js";

test("OpenAIRealtimeClient mints a scoped client secret", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json({ value: "ek_test", expires_at: 12345 });
  }) as typeof fetch;

  const client = new OpenAIRealtimeClient({
    apiKey: "server-secret",
    baseUrl: "https://openai.example/",
    fetch: mockFetch,
  });
  const secret = await client.createClientSecret({
    safetyIdentifier: "hashed-user",
    session: {
      type: "realtime",
      model: "gpt-realtime-test",
      audio: { output: { voice: "marin" } },
    },
  });

  assert.equal(secret.value, "ek_test");
  assert.equal(requestUrl, "https://openai.example/v1/realtime/client_secrets");
  assert.equal(requestInit?.method, "POST");
  const headers = requestInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer server-secret");
  assert.equal(headers["OpenAI-Safety-Identifier"], "hashed-user");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    session: {
      type: "realtime",
      model: "gpt-realtime-test",
      audio: { output: { voice: "marin" } },
    },
  });
});

test("OpenAIRealtimeClient reports upstream errors without returning a token", async () => {
  const client = new OpenAIRealtimeClient({
    apiKey: "server-secret",
    fetch: (async () =>
      Response.json({ error: { message: "bad request" } }, { status: 400 })) as typeof fetch,
  });

  await assert.rejects(
    () =>
      client.createClientSecret({
        session: { type: "realtime", model: "invalid" },
      }),
    (error: unknown) =>
      error instanceof UpstreamApiError &&
      error.service === "OpenAI" &&
      error.status === 400,
  );
});
