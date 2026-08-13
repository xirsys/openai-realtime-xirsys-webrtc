import { UpstreamApiError, parseResponseBody } from "./errors.js";

export interface RealtimeSessionConfig {
  type: "realtime";
  model: string;
  instructions?: string;
  audio?: {
    output?: {
      voice?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CreateClientSecretOptions {
  session: RealtimeSessionConfig;
  /** A stable, privacy-preserving identifier derived by the trusted backend. */
  safetyIdentifier?: string;
}

export interface RealtimeClientSecret {
  value: string;
  expires_at?: number;
  [key: string]: unknown;
}

export interface OpenAIRealtimeClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Small server-side SDK for minting browser-safe Realtime client secrets. */
export class OpenAIRealtimeClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAIRealtimeClientOptions) {
    if (!options.apiKey) throw new TypeError("OpenAI apiKey is required");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async createClientSecret(
    options: CreateClientSecretOptions,
  ): Promise<RealtimeClientSecret> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "Content-Type": "application/json",
    };

    if (options.safetyIdentifier) {
      headers["OpenAI-Safety-Identifier"] = options.safetyIdentifier;
    }

    const response = await this.#fetch(`${this.#baseUrl}/v1/realtime/client_secrets`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session: options.session }),
    });
    const body = await parseResponseBody(response);

    if (!response.ok) {
      throw new UpstreamApiError(
        "OpenAI",
        response.status,
        `OpenAI client-secret request failed (${response.status})`,
        body,
      );
    }

    if (!isClientSecret(body)) {
      throw new UpstreamApiError(
        "OpenAI",
        response.status,
        "OpenAI returned an invalid client-secret response",
      );
    }

    return body;
  }
}

function isClientSecret(value: unknown): value is RealtimeClientSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof value.value === "string" &&
    value.value.length > 0
  );
}
