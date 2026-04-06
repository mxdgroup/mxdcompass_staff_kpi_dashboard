import { NextResponse } from "next/server";

// Step 1: Redirect user to Wrike authorization page
export async function GET(request: Request) {
  const clientId = process.env.WRIKE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "WRIKE_CLIENT_ID not set" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  // Step 2: If we have a code, exchange it for an access token
  if (code) {
    const clientSecret = process.env.WRIKE_SECRET_KEY ?? process.env.WRIKE_CLIENT_SECRET;
    if (!clientSecret) {
      return NextResponse.json({ error: "WRIKE_SECRET_KEY not set" }, { status: 500 });
    }

    const tokenRes = await fetch("https://login.wrike.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      return NextResponse.json({
        success: true,
        message: "Copy this access_token to your Vercel env vars as WRIKE_PERMANENT_ACCESS_TOKEN",
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        refresh_token: tokenData.refresh_token,
        host: tokenData.host,
      });
    }

    return NextResponse.json({
      error: "Token exchange failed",
      details: tokenData,
    }, { status: 400 });
  }

  // Step 1: No code yet — redirect to Wrike auth
  const redirectUri = new URL("/api/wrike-auth", request.url).toString();
  const authUrl = `https://login.wrike.com/oauth2/authorize/v4?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return NextResponse.redirect(authUrl);
}
