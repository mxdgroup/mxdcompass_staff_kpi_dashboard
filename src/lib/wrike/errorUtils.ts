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
