const { NextResponse } = require("next/server");
const { SESSION_COOKIE } = require("../../../../lib/session");

async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

module.exports = { POST };
