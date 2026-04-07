import { cookies } from "next/headers";
import { createHash } from "crypto";

const SESSION_COOKIE = "kpi_session";
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

function getSessionToken(): string {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) throw new Error("DASHBOARD_PASSWORD not set");
  return createHash("sha256").update(password + ":kpi-session-v1").digest("hex");
}

export async function login(password: string): Promise<boolean> {
  if (password !== process.env.DASHBOARD_PASSWORD) return false;

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, getSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL,
    path: "/kpi",
  });
  return true;
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE);
  if (!session) return false;
  return session.value === getSessionToken();
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
