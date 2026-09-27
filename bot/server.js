require("dotenv").config();
const { createServer } = require("http");
const next = require("next");
const { startBot } = require("./src/bot");

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

const port = process.env.PORT || 3000;

async function main() {
  // 1. Boot the Next.js dashboard (handles "/", "/dashboard/*", "/api/*").
  await app.prepare();

  createServer((req, res) => handle(req, res)).listen(port, () => {
    console.log(`[web] Dashboard listening on port ${port}`);
  });

  // 2. Boot the Discord bot in the same process. If this crashes, the whole
  //    service goes down with it — which is what you want on Render: a
  //    single health-checked process instead of two out-of-sync ones.
  await startBot();
}

main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
