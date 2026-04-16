import { NextResponse } from "next/server";

export function middleware() {
  const response = NextResponse.next();

  // Only allow embedding within the Compass app
  response.headers.set(
    "Content-Security-Policy",
    "frame-ancestors https://compass.mxd.digital"
  );

  return response;
}

export const config = {
  matcher: ["/", "/flow", "/yesterday"],
};
