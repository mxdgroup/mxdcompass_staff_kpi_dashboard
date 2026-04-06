// Wrike API v4 client with throttling, retry, and pagination

import type { WrikeApiResponse } from "./types";
import { buildServiceError, isRetryable } from "./errorUtils";

const BASE_URL = "https://www.wrike.com/api/v4";
const MIN_REQUEST_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoffMs(attempt: number): number {
  const base = 800 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(base + jitter, 8_000);
}

export class WrikeClient {
  private token: string;
  private nextRequestSlotAt = 0;
  private requestSlotChain: Promise<void> = Promise.resolve();

  constructor(token?: string) {
    const resolved =
      token ??
      process.env.WRIKE_PERMANENT_ACCESS_TOKEN ??
      process.env.WRIKE_TOKEN ??
      process.env.wrike_permanent_access_token ??
      undefined;
    if (!resolved) {
      throw new Error(
        "Missing Wrike token. Set WRIKE_PERMANENT_ACCESS_TOKEN, WRIKE_TOKEN, or wrike_permanent_access_token.",
      );
    }
    this.token = resolved;
  }

  // ---------- throttle ----------

  private async throttle(): Promise<void> {
    let waitMs = 0;

    const reserveSlot = () => {
      const now = Date.now();
      const slotAt = Math.max(now, this.nextRequestSlotAt);
      waitMs = Math.max(0, slotAt - now);
      this.nextRequestSlotAt = slotAt + MIN_REQUEST_INTERVAL_MS;
    };

    this.requestSlotChain = this.requestSlotChain.then(
      reserveSlot,
      reserveSlot,
    );
    await this.requestSlotChain;

    if (waitMs > 0) {
      await wait(waitMs);
    }
  }

  // ---------- single request ----------

  private async request<T>(
    path: string,
    params: Record<string, unknown> = {},
    attempt = 0,
  ): Promise<WrikeApiResponse<T>> {
    await this.throttle();

    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) || typeof value === "object") {
        url.searchParams.set(key, JSON.stringify(value));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `bearer ${this.token}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();

        if (isRetryable(response.status) && attempt < MAX_RETRIES) {
          await wait(jitteredBackoffMs(attempt));
          return this.request<T>(path, params, attempt + 1);
        }

        const err = buildServiceError(
          `Wrike API error ${response.status}: ${body.slice(0, 300)}`,
          response.status,
          body,
        );
        throw new Error(err.message);
      }

      return (await response.json()) as WrikeApiResponse<T>;
    } catch (error: unknown) {
      const isAbort =
        error instanceof DOMException && error.name === "AbortError";
      const isNetwork = error instanceof TypeError || isAbort;

      if (isNetwork && attempt < MAX_RETRIES) {
        await wait(jitteredBackoffMs(attempt));
        return this.request<T>(path, params, attempt + 1);
      }

      if (isAbort) {
        throw new Error(`Wrike API timeout: request exceeded ${REQUEST_TIMEOUT_MS}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- paginated GET ----------

  async get<T>(
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    // Single page fetch — Wrike returns up to 1000 results per call.
    // For a 6-10 person agency this is always sufficient.
    const response = await this.request<T>(path, params);
    return Array.isArray(response.data) ? response.data : [];
  }
}

/** Shared singleton — lazy-initialised on first import that calls it. */
let _instance: WrikeClient | undefined;

export function getWrikeClient(): WrikeClient {
  if (!_instance) {
    _instance = new WrikeClient();
  }
  return _instance;
}
