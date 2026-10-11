// `npm run demo`: opens a Chromium window with the extension loaded, seeded favorites and the synthetic YouTube page.
// Needs a Chromium build that still accepts --load-extension (Google Chrome stable does not). Set CHROME_BIN to pick one.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "./serve.mjs";
import { browserArgs, extensionId, repoRoot, seedExpression } from "./seed.mjs";

const candidates = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser", "microsoft-edge"];

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of candidates) {
      const file = path.join(dir, name);
      if (existsSync(file)) return file;
    }
  }
  throw new Error("No Chromium found. Install Chromium or set CHROME_BIN to a build that supports --load-extension.");
}

// Chrome writes its debugging port and browser socket path to this file once it is listening.
async function waitForDevTools(userDataDir) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      const [port, wsPath] = readFileSync(file, "utf8").trim().split("\n");
      return { port, wsPath };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not start its DevTools port.");
}

// A small DevTools client: send a command, optionally to one attached target.
function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const reply = pending.get(message.id);
    if (!reply) return;
    pending.delete(message.id);
    message.error ? reply.reject(new Error(message.error.message)) : reply.resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`Cannot reach Chrome's DevTools at ${url}`));
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ready, send, close: () => socket.close() };
}

async function seedFavorites(cdp, id) {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${id}/options.html` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: seedExpression, awaitPromise: true, returnByValue: true }, sessionId).catch(() => ({}));
    if (result?.value === "seeded") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await cdp.send("Target.closeTarget", { targetId });
}

const server = await startServer();
const userDataDir = await mkdtemp(path.join(os.tmpdir(), "better-youtube-profile-"));
const chrome = spawn(findChrome(), [
  `--user-data-dir=${userDataDir}`,
  `--load-extension=${repoRoot}`,
  `--disable-extensions-except=${repoRoot}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  ...browserArgs(server.port),
  "about:blank",
], { stdio: "ignore" });

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  chrome.kill();
  await server.close();
  await rm(userDataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
chrome.on("exit", shutdown);

const { port, wsPath } = await waitForDevTools(userDataDir);
const cdp = connect(`ws://127.0.0.1:${port}${wsPath}`);
await cdp.ready;
await seedFavorites(cdp, extensionId());
// The content script scans on requestAnimationFrame, which a background tab never runs, so the page must be in front.
const { targetId } = await cdp.send("Target.createTarget", { url: "https://www.youtube.com/" });
await cdp.send("Target.activateTarget", { targetId });
cdp.close();

console.log("Better Youtube demo running on a synthetic YouTube page. Quick add a video, or open Playlists in the sidebar; no account needed.");
console.log("Press Ctrl-C or close the window to stop.");
