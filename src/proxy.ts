import { NextResponse } from "next/server";

export default function proxy() {
  const response = NextResponse.next();

  // Only allow embedding within the Compass app
  response.headers.set(
    "Content-Security-Policy",
    "frame-ancestors https://compass.mxd.digital"
  );

  return response;
}
