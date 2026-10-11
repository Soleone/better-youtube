#!/usr/bin/env node
// Records the Quick add loop for the README: add a video to a playlist, undo it, and end where the clip began.
// Usage: npm run media:capture. Needs agent-browser (with its browser installed) and FFmpeg on the PATH.
import { record } from "@soleone/showcase/capture";
import { browserArgs, extensionId, repoRoot, samplePlaylists, seedExpression } from "../demo/seed.mjs";
import { startServer } from "../demo/serve.mjs";

const woodworking = samplePlaylists.find((playlist) => playlist.title === "Woodworking");
const server = await startServer();

// agent-browser reads these when it opens the session, so the extension and the host rule apply to every take.
process.env.AGENT_BROWSER_EXTENSIONS = repoRoot;
process.env.AGENT_BROWSER_ARGS = browserArgs(server.port).join(",");

const take = () => record({
  url: "https://www.youtube.com/",
  out: "docs/media/quick-add.webp",
  attempts: 5,
  async start(page) {
    // The favorites live in the extension's storage, which is empty in a fresh session, so seed them first.
    await page.run("open", `chrome-extension://${extensionId()}/options.html`);
    await page.eval(seedExpression);
    await page.run("open", "https://www.youtube.com/");
    await page.waitFor(`document.querySelectorAll(".ytqf-trigger").length === 12`, { timeoutMs: 30_000 });
    // Without this pause the first frames catch the page mid-paint and look scrolled.
    await page.sleep(1500);
  },
  async drive(page) {
    await page.sleep(1200);
    await page.click("Quick add");
    await page.waitFor(`document.querySelector(".ytqf-panel") !== null`);
    await page.sleep(600);
    await page.click(woodworking.title);
    await page.waitFor(`[...document.querySelectorAll(".ytqf-trigger")].some((trigger) => trigger.textContent.trim() === "Undo")`);
    await page.sleep(2200);
    await page.click("Undo");
    await page.waitFor(`document.querySelector(".ytqf-trigger").textContent.trim() === "Quick add"`, { timeoutMs: 15_000 });
    await page.sleep(1500);
  },
  async verify(page) {
    const playlists = await page.eval(`window.__demoPlaylistEdits.map((edit) => edit.playlistId)`);
    if (!playlists.includes(woodworking.id)) return "the add never reached the playlist endpoint";
  },
});

// The stream sometimes sends almost nothing during a take, and the recorder keeps such a take as a frozen clip.
// Retry here when it sent fewer than six frames, and when the recorder throws (it does not retry those itself).
try {
  let result;
  for (let run = 1; !result; run += 1) {
    try {
      const attemptResult = await take();
      if (attemptResult.frames < 6) throw new Error(`The take has only ${attemptResult.frames} stream frames`);
      result = attemptResult;
    } catch (error) {
      if (run >= 3) throw error;
      console.error(`${error.message}. Recording again.`);
    }
  }
  const { frames, durationMs, grid } = result;
  console.log(`Wrote docs/media/quick-add.webp (${frames} frames, ${(durationMs / 1000).toFixed(1)} s). Check the frames in ${grid}.`);
} finally {
  await server.close();
}
