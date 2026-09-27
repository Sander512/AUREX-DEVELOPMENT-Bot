// GET /api/auth/discord/callback — Discord redirects back here with a code.

const { NextResponse } = require("next/server");
const {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  CALLBACK_COOKIE,
  MAX_AGE_MS,
  sign,
} = require("../../../../../lib/session");
const { exchangeCode, fetchUser } = require("../../../../../lib/discordOAuth");

async function GET(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const secure = process.env.NODE_ENV === "production";
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

module.exports = { GET };
