import { UpstreamApiError, parseResponseBody } from "./errors.js";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface XirsysClientOptions {
  ident: string;
  secret: string;
  channel: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface IceCredentialOptions {
  expiresInSeconds?: number;
  /** Trusted end-user public IP, used only with Xirsys geo routing. */
  userIp?: string;
}

export interface SignalingCredentialOptions {
  peerId: string;
  expiresInSeconds?: number;
}

export interface XirsysSignalingCredentials {
  url: string;
  peerId: string;
  expiresInSeconds: number;
}

interface XirsysEnvelope {
  s?: string;
  v?: unknown;
  [key: string]: unknown;
}

/** Server-only SDK for short-lived Xirsys ICE and signaling credentials. */
export class XirsysClient {
  readonly #channel: string;
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(options: XirsysClientOptions) {
    if (!options.ident) throw new TypeError("Xirsys ident is required");
    if (!options.secret) throw new TypeError("Xirsys secret is required");
    if (!options.channel) throw new TypeError("Xirsys channel is required");

    this.#channel = options.channel;
    this.#baseUrl = (options.baseUrl ?? "https://global.xirsys.net").replace(/\/$/, "");
    this.#authorization = `Basic ${Buffer.from(`${options.ident}:${options.secret}`).toString("base64")}`;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getIceServers(options: IceCredentialOptions = {}): Promise<IceServer[]> {
    const expiresInSeconds = validateTtl(options.expiresInSeconds ?? 60, "ICE");
    const params = new URLSearchParams({
      webrtc: "1",
      expire: String(expiresInSeconds),
    });
    const headers: Record<string, string> = {
      Authorization: this.#authorization,
    };
    let body: string | undefined;

    if (options.userIp) {
      params.set("geo", "1");
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ user_ip: options.userIp });
    }

    const response = await this.#fetch(
      `${this.#baseUrl}/_turn/${encodeURIComponent(this.#channel)}?${params}`,
      {
        method: "PUT",
        headers,
        ...(body ? { body } : {}),
      },
    );
    const envelope = await this.#readEnvelope(response, "TURN credential");
    const iceServers = getRecord(envelope.v)?.iceServers;

    if (!Array.isArray(iceServers) || !iceServers.every(isIceServer)) {
      throw new UpstreamApiError(
        "Xirsys",
        response.status,
        "Xirsys returned an invalid ICE server response",
      );
    }

    return iceServers;
  }

  async getSignalingCredentials(
    options: SignalingCredentialOptions,
  ): Promise<XirsysSignalingCredentials> {
    if (!/^[A-Za-z0-9._~-]{1,64}$/.test(options.peerId)) {
      throw new TypeError(
        "peerId must be 1-64 URL-safe characters (letters, numbers, dot, underscore, tilde, or hyphen)",
      );
    }

    const expiresInSeconds = validateTtl(
      options.expiresInSeconds ?? 120,
      "signaling",
    );
    const tokenParams = new URLSearchParams({
      k: options.peerId,
      expire: String(expiresInSeconds),
    });

    const [hostResponse, tokenResponse] = await Promise.all([
      this.#fetch(`${this.#baseUrl}/_host?type=signal`, {
        headers: { Authorization: this.#authorization },
      }),
      this.#fetch(
        `${this.#baseUrl}/_token/${encodeURIComponent(this.#channel)}?${tokenParams}`,
        {
          method: "PUT",
          headers: { Authorization: this.#authorization },
        },
      ),
    ]);

    const [hostEnvelope, tokenEnvelope] = await Promise.all([
      this.#readEnvelope(hostResponse, "signaling host"),
      this.#readEnvelope(tokenResponse, "signaling token"),
    ]);

    if (typeof hostEnvelope.v !== "string" || typeof tokenEnvelope.v !== "string") {
      throw new UpstreamApiError(
        "Xirsys",
        502,
        "Xirsys returned invalid signaling credentials",
      );
    }

    return {
      url: `${hostEnvelope.v.replace(/\/$/, "")}/v2/${encodeURIComponent(tokenEnvelope.v)}`,
      peerId: options.peerId,
      expiresInSeconds,
    };
  }

  async #readEnvelope(response: Response, operation: string): Promise<XirsysEnvelope> {
    const body = await parseResponseBody(response);
    if (!response.ok || !isEnvelope(body) || body.s !== "ok") {
      throw new UpstreamApiError(
        "Xirsys",
        response.status,
        `Xirsys ${operation} request failed (${response.status})`,
        body,
      );
    }
    return body;
  }
}

function validateTtl(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 21_600) {
    throw new RangeError(`${label} credential lifetime must be an integer from 1 to 21600 seconds`);
  }
  return value;
}

function isEnvelope(value: unknown): value is XirsysEnvelope {
  return typeof value === "object" && value !== null;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isIceServer(value: unknown): value is IceServer {
  const urls = getRecord(value)?.urls;
  return (
    typeof urls === "string" ||
    (Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === "string"))
  );
}
