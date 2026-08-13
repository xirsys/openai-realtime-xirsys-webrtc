export class UpstreamApiError extends Error {
  readonly service: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(service: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "UpstreamApiError";
    this.service = service;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 1_000);
  }
}
