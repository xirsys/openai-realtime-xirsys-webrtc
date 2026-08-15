import { BlockList, isIP } from "node:net";

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
  /**
   * Trusted end-user public IP. When present, the SDK enables Xirsys geo
   * routing with both `geo=1` and the required `user_ip` request field.
   * Derive this server-side from trusted request context; never accept an
   * arbitrary browser-supplied value.
   */
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
    const userIp = options.userIp;
    const headers: Record<string, string> = {
      Authorization: this.#authorization,
    };
    let body: string | undefined;

    if (userIp !== undefined) {
      if (!isPublicIpAddress(userIp)) {
        throw new TypeError("userIp must be a valid public IPv4 or IPv6 address");
      }
      params.set("geo", "1");
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ user_ip: userIp });
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
    const iceServerValue = getRecord(envelope.v)?.iceServers;
    const iceServers = Array.isArray(iceServerValue)
      ? iceServerValue
      : isIceServer(iceServerValue)
        ? [iceServerValue]
        : undefined;

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

/**
 * Returns whether an address is suitable as a Xirsys end-user geo hint.
 * This validates address scope only; callers must still establish the IP's
 * trustworthiness from their server or trusted proxy configuration.
 */
export function isPublicIpAddress(value: string): boolean {
  const version = isIP(value);
  if (version === 4) return !nonPublicIpv4Ranges.check(value, "ipv4");
  if (version === 6) return !nonPublicIpv6Ranges.check(value, "ipv6");
  return false;
}

function createNonPublicIpv4Ranges(): BlockList {
  const ranges = new BlockList();

  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    ranges.addSubnet(network, prefix, "ipv4");
  }

  return ranges;
}

function createNonPublicIpv6Ranges(): BlockList {
  const ranges = new BlockList();

  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0.0.0.0", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    ranges.addSubnet(network, prefix, "ipv6");
  }

  return ranges;
}

const nonPublicIpv4Ranges = createNonPublicIpv4Ranges();
const nonPublicIpv6Ranges = createNonPublicIpv6Ranges();
