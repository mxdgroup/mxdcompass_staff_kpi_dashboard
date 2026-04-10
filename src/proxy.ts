import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED_HOST = "compass.mxd.digital";

export default function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0];

  // Allow in development
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  if (host !== ALLOWED_HOST) {
    return new NextResponse("Not Found", { status: 404 });
  }

  return NextResponse.next();
}
