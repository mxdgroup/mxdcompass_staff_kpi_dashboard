// Wrike error utilities

export interface ServiceError {
  message: string;
  statusCode?: number;
  response?: string;
}

/**
 * Build a structured error object with optional status code and response body.
 */
export function buildServiceError(
  message: string,
  statusCode?: number,
  response?: string,
): ServiceError {
  return { message, statusCode, response };
}

/**
 * Returns true if the HTTP status code warrants a retry.
 */
export function isRetryable(statusCode: number): boolean {
  return (
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  );
}

/**
 * P14: Parse the Retry-After header from a response.
 * Returns milliseconds to wait, or null if header is absent/unparseable.
 */
export function getRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  // Retry-After can be seconds (integer) or HTTP-date
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try HTTP-date format
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : null;
  }

  return null;
}
