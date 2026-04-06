import { NextResponse } from "next/server";
import { login } from "@/lib/auth";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.password) {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  const success = await login(body.password);
  if (!success) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
