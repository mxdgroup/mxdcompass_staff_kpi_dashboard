const BASE_URL = "https://api.github.com";

interface SearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: Record<string, unknown>[];
}

function getHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function buildUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Link header to extract the URL for a given rel (e.g. "next").
 */
function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  const parts = header.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      links[match[2]] = match[1];
    }
  }
  return links;
}

/**
 * Generic GET request against the GitHub REST API.
 * Follows pagination automatically and concatenates array results.
 */
export async function get<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = buildUrl(path, { per_page: "100", ...params });
  const response = await fetch(url, { headers: getHeaders() });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API error ${response.status} for ${url}: ${body}`,
    );
  }

  let data = (await response.json()) as T;

  // Auto-paginate if the response is an array
  if (Array.isArray(data)) {
    let results = [...data] as unknown[];
    let nextUrl = parseLinkHeader(response.headers.get("link")).next;

    while (nextUrl) {
      const nextResponse = await fetch(nextUrl, { headers: getHeaders() });
      if (!nextResponse.ok) break;
      const page = (await nextResponse.json()) as unknown[];
      results = results.concat(page);
      nextUrl = parseLinkHeader(nextResponse.headers.get("link")).next;
    }

    data = results as unknown as T;
  }

  return data;
}

// Track the last time a search call was made to enforce the 2-second delay.
let lastSearchCallTime = 0;

/**
 * Search issues/PRs via GitHub Search API.
 * Enforces a minimum 2-second delay between consecutive calls to stay
 * within the 30 requests/minute secondary rate limit.
 */
export async function searchIssues(query: string): Promise<SearchResult> {
  const now = Date.now();
  const elapsed = now - lastSearchCallTime;
  if (elapsed < 2000) {
    await sleep(2000 - elapsed);
  }
  lastSearchCallTime = Date.now();

  const url = buildUrl("/search/issues", {
    q: query,
    per_page: "100",
  });

  const response = await fetch(url, { headers: getHeaders() });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub Search API error ${response.status}: ${body}`,
    );
  }

  const data = (await response.json()) as SearchResult;

  // Handle pagination for search results (>100 items)
  let allItems = [...data.items];
  let nextUrl = parseLinkHeader(response.headers.get("link")).next;

  while (nextUrl) {
    const sinceLastCall = Date.now() - lastSearchCallTime;
    if (sinceLastCall < 2000) {
      await sleep(2000 - sinceLastCall);
    }
    lastSearchCallTime = Date.now();

    const nextResponse = await fetch(nextUrl, { headers: getHeaders() });
    if (!nextResponse.ok) break;
    const page = (await nextResponse.json()) as SearchResult;
    allItems = allItems.concat(page.items);
    nextUrl = parseLinkHeader(nextResponse.headers.get("link")).next;
  }

  return {
    total_count: data.total_count,
    incomplete_results: data.incomplete_results,
    items: allItems,
  };
}
