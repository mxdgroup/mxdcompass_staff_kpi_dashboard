// Wrike API v4 client with throttling, retry, and pagination

import type { WrikeApiResponse } from "./types";
import type { WrikeComment } from "./types";
import { buildServiceError, isRetryable, getRetryAfterMs } from "./errorUtils";

const BASE_URL = "https://www.wrike.com/api/v4";
// Wrike allows ~400 req/min. 180ms keeps us below that ceiling while letting
// concurrent comment fetches overlap enough to fit inside Vercel's 300s budget.
const MIN_REQUEST_INTERVAL_MS = 180;
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
      token ?? process.env.WRIKE_PERMANENT_ACCESS_TOKEN ?? undefined;
    if (!resolved) {
      throw new Error(
        "Missing Wrike token. Set WRIKE_PERMANENT_ACCESS_TOKEN or pass a token.",
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
          // P14: Honor Retry-After header, but never go below jittered backoff
          const retryAfter = getRetryAfterMs(response);
          const backoff = jitteredBackoffMs(attempt);
          await wait(retryAfter ? Math.max(retryAfter, backoff) : backoff);
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

  // ---------- single PUT ----------

  async put<T>(
    path: string,
    body: Record<string, string> = {},
    attempt = 0,
  ): Promise<WrikeApiResponse<T>> {
    await this.throttle();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "PUT",
        headers: {
          Authorization: `bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body).toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();

        if (isRetryable(response.status) && attempt < MAX_RETRIES) {
          const retryAfter = getRetryAfterMs(response);
          const backoff = jitteredBackoffMs(attempt);
          await wait(retryAfter ? Math.max(retryAfter, backoff) : backoff);
          return this.put<T>(path, body, attempt + 1);
        }

        const err = buildServiceError(
          `Wrike API error ${response.status}: ${text.slice(0, 300)}`,
          response.status,
          text,
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
        return this.put<T>(path, body, attempt + 1);
      }

      if (isAbort) {
        throw new Error(`Wrike API timeout: request exceeded ${REQUEST_TIMEOUT_MS}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- single POST ----------

  async post<T>(
    path: string,
    body: Record<string, string> = {},
    attempt = 0,
  ): Promise<WrikeApiResponse<T>> {
    await this.throttle();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body).toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();

        if (isRetryable(response.status) && attempt < MAX_RETRIES) {
          const retryAfter = getRetryAfterMs(response);
          const backoff = jitteredBackoffMs(attempt);
          await wait(retryAfter ? Math.max(retryAfter, backoff) : backoff);
          return this.post<T>(path, body, attempt + 1);
        }

        const err = buildServiceError(
          `Wrike API error ${response.status}: ${text.slice(0, 300)}`,
          response.status,
          text,
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
        return this.post<T>(path, body, attempt + 1);
      }

      if (isAbort) {
        throw new Error(`Wrike API timeout: request exceeded ${REQUEST_TIMEOUT_MS}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- single DELETE ----------

  async delete(path: string, attempt = 0): Promise<void> {
    await this.throttle();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "DELETE",
        headers: { Authorization: `bearer ${this.token}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();

        if (isRetryable(response.status) && attempt < MAX_RETRIES) {
          const retryAfter = getRetryAfterMs(response);
          const backoff = jitteredBackoffMs(attempt);
          await wait(retryAfter ? Math.max(retryAfter, backoff) : backoff);
          return this.delete(path, attempt + 1);
        }

        const err = buildServiceError(
          `Wrike API error ${response.status}: ${text.slice(0, 300)}`,
          response.status,
          text,
        );
        throw new Error(err.message);
      }
    } catch (error: unknown) {
      const isAbort =
        error instanceof DOMException && error.name === "AbortError";
      const isNetwork = error instanceof TypeError || isAbort;

      if (isNetwork && attempt < MAX_RETRIES) {
        await wait(jitteredBackoffMs(attempt));
        return this.delete(path, attempt + 1);
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
    const all: T[] = [];
    let nextPageToken: string | undefined;

    do {
      const requestParams = { ...params };
      if (nextPageToken) {
        requestParams.nextPageToken = nextPageToken;
      }

      let response: WrikeApiResponse<T>;
      try {
        response = await this.request<T>(path, requestParams);
      } catch (err) {
        // P13: Throw on pagination failure — partial data is worse than no data
        if (nextPageToken && all.length > 0) {
          throw new Error(
            `Wrike pagination failed for ${path} after collecting ${all.length} items: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }

      if (Array.isArray(response.data)) {
        all.push(...response.data);
      }

      // Only continue pagination if we got data AND a valid token.
      // Some Wrike endpoints (e.g. timelogs) return nextPageToken even
      // with 0 results, causing the next request to fail.
      const gotData = Array.isArray(response.data) && response.data.length > 0;
      nextPageToken =
        gotData &&
        response.nextPageToken &&
        typeof response.nextPageToken === "string"
          ? response.nextPageToken
          : undefined;
    } while (nextPageToken);

    return all;
  }

  async getCommentsByTaskIds(
    taskIds: string[],
  ): Promise<Map<string, WrikeComment[]>> {
    if (taskIds.length === 0) {
      return new Map();
    }

    const commentsByTask = new Map<string, WrikeComment[]>();

    await Promise.all(
      taskIds.map(async (taskId) => {
        const comments = await this.get<WrikeComment>(`/tasks/${taskId}/comments`);
        if (comments.length === 0) {
          return;
        }

        commentsByTask.set(
          taskId,
          comments.map((comment) => ({
            ...comment,
            taskId: comment.taskId || taskId,
          })),
        );
      }),
    );

    return commentsByTask;
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
