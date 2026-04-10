import { NextResponse, type NextRequest } from "next/server";

const ALLOWED_HOST = "compass.mxd.digital";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";

  if (host !== ALLOWED_HOST) {
    return new NextResponse("Not Found", { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths under /kpi except static assets and Next.js internals
    "/kpi/:path*",
  ],
};
