#!/usr/bin/env node
// Records the README loop and the showcase hero still. The loop adds a video to a playlist from Home, undoes it, then
// uses the sidebar's Playlists entry to jump to a favorite playlist. The clip ends on that playlist page, and the loop
// cuts back to Home. The hero is a screenshot of the open Playlists panel.
// Usage: npm run media:capture. Needs agent-browser (with its browser installed) and FFmpeg on the PATH.
import { readFile } from "node:fs/promises";
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
    await page.sleep(2000);
    await page.click("Undo");
    await page.waitFor(`document.querySelector(".ytqf-trigger").textContent.trim() === "Quick add"`, { timeoutMs: 15_000 });
    // Checked here, before the jump: navigating to the playlist page starts a fresh page and clears the demo's record.
    const edits = await page.eval(`window.__demoPlaylistEdits.map((edit) => edit.playlistId)`);
    if (!edits.includes(woodworking.id)) throw new Error("the add never reached the playlist endpoint");
    await page.sleep(1000);

    await page.click("Playlists");
    await page.waitFor(`document.querySelector(".ytqf-panel") !== null`);
    await page.sleep(800);
    await page.run("screenshot", "docs/media/hero.png");
    await page.sleep(500);
    await page.click(woodworking.title);
    await page.waitFor(`document.querySelectorAll("ytd-playlist-video-renderer").length === 3`, { timeoutMs: 15_000 });
    await page.sleep(2200);
  },
  async verify(page) {
    const where = await page.eval("location.pathname + location.search");
    if (!where.includes(woodworking.id)) return "the sidebar jump did not reach the playlist page";
  },
});

// Reads the frame count and total length from the WebP's own container, so a short encode is caught before it is kept.
function webpTiming(buffer) {
  let frames = 0;
  let durationMs = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (type === "ANMF") {
      frames += 1;
      durationMs += buffer.readUIntLE(offset + 8 + 12, 3);
    }
    offset += 8 + size + (size % 2);
  }
  return { frames, durationMs };
}

// The stream sometimes sends almost nothing during a take, and the recorder keeps such a take as a frozen clip.
// The encoder once wrote a 13 s take as a 5 s loop. Retry here when the take or the file is too short, and when the
// recorder throws (it does not retry those itself).
try {
  let result;
  for (let run = 1; !result; run += 1) {
    try {
      const attemptResult = await take();
      if (attemptResult.frames < 6) throw new Error(`The take has only ${attemptResult.frames} stream frames`);
      const timing = webpTiming(await readFile("docs/media/quick-add.webp"));
      if (timing.frames < 6 || Math.abs(timing.durationMs - attemptResult.durationMs) > 500) {
        throw new Error(`The loop has ${timing.frames} frames and ${timing.durationMs} ms, not the ${attemptResult.durationMs} ms take`);
      }
      result = attemptResult;
    } catch (error) {
      if (run >= 3) throw error;
      console.error(`${error.message}. Recording again.`);
    }
  }
  const { frames, durationMs, grid } = result;
  console.log(`Wrote docs/media/quick-add.webp (${frames} frames, ${(durationMs / 1000).toFixed(1)} s). Check the frames in ${grid}.`);
  console.log("Wrote docs/media/hero.png.");
} finally {
  await server.close();
}
