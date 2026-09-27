// GET /api/auth/discord — handles BOTH steps of the OAuth2 flow in one
// file, so there's no separate /callback subfolder to upload:
//   1. No `code`/`state`/`error` in the URL yet  -> start the flow, send
//      the user to Discord.
//   2. `code`/`state` present (Discord redirected back here)            -> finish
//      the flow, verify, and set the session cookie.
// Discord doesn't care that both steps live at the same URL — the
// redirect_uri only has to be a URL Discord can send the user back to
// with ?code=...&state=..., and this one qualifies either way.

const crypto = require("crypto");
const { NextResponse } = require("next/server");
const {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  CALLBACK_COOKIE,
  MAX_AGE_MS,
  sign,
} = require("../../../../lib/session");
const { buildAuthorizeUrl, getRedirectUri, exchangeCode, fetchUser } = require("../../../../lib/discordOAuth");

async function GET(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const secure = process.env.NODE_ENV === "production";

  // --- Step 2: Discord redirected back here with a code (or an error) ---
  if (code || state || oauthError) {
    const redirectTo = (path) => NextResponse.redirect(new URL(path, url.origin));

    if (oauthError) {
      return redirectTo(`/?login_error=${encodeURIComponent(oauthError)}`);
    }

    const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
    const callbackUrl = request.cookies.get(CALLBACK_COOKIE)?.value || "/";

    // The `state` param must round-trip through the user's own browser —
    // this is what defends the redirect against CSRF.
    if (!code || !state || !cookieState || state !== cookieState) {
      return redirectTo("/?login_error=invalid_state");
    }

    let tokenData;
    try {
      tokenData = await exchangeCode(code);
    } catch (err) {
      console.error("[auth] Discord token-uitwisseling mislukt:", err);
      return redirectTo("/?login_error=token_exchange_failed");
    }

    let discordUser;
    try {
      discordUser = await fetchUser(tokenData.access_token);
    } catch (err) {
      console.error("[auth] Kon Discord-gebruiker niet ophalen:", err);
      return redirectTo("/?login_error=profile_fetch_failed");
    }

    const response = redirectTo(callbackUrl);

    response.cookies.set(
      SESSION_COOKIE,
      sign({ discordId: discordUser.id, username: discordUser.username, avatar: discordUser.avatar || null }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        maxAge: Math.floor(MAX_AGE_MS / 1000),
      }
    );
    // Clean up the short-lived OAuth cookies now that login is done.
    response.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    response.cookies.set(CALLBACK_COOKIE, "", { path: "/", maxAge: 0 });

    return response;
  }

  // --- Step 1: kick off the flow ---
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !getRedirectUri()) {
    return NextResponse.json(
      {
        error:
          "Discord login is niet geconfigureerd (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / NEXTAUTH_URL ontbreken).",
      },
      { status: 500 }
    );
  }

  const callbackUrl = url.searchParams.get("callbackUrl") || "/";
  const newState = crypto.randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(buildAuthorizeUrl(newState));

  response.cookies.set(OAUTH_STATE_COOKIE, newState, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 5 * 60, // 5 minutes — only needs to survive the OAuth round-trip
  });
  response.cookies.set(CALLBACK_COOKIE, callbackUrl, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 5 * 60,
  });

  return response;
}

module.exports = { GET };
