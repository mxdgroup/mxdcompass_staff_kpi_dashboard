import { NextRequest, NextResponse } from "next/server";

const PPC_API_URL =
  process.env.PPC_API_URL ?? "https://web-production-64f6a.up.railway.app";
const PPC_API_KEY = process.env.PPC_API_KEY ?? "";

/**
 * Proxy all /api/ppc/* requests to the Railway PPC Analyser backend.
 * Injects X-API-Key server-side so the key never reaches the browser.
 */
async function proxyRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const upstream = `${PPC_API_URL}/api/ppc/${path.join("/")}`;
  const url = new URL(upstream);

  // Forward query params
  request.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

  const headers: HeadersInit = {
    "X-API-Key": PPC_API_KEY,
    "Content-Type": "application/json",
  };

  const init: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      init.body = await request.text();
    } catch {
      // no body
    }
  }

  try {
    const res = await fetch(url.toString(), init);
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `PPC API proxy error: ${err}` },
      { status: 502 }
    );
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PATCH = proxyRequest;
export const PUT = proxyRequest;
export const DELETE = proxyRequest;
