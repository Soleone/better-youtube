// `npm run demo:web`: builds the hosted demo into dist/web. The synthetic page from demo/fixture gets the extension's
// scripts inline, after a small chrome.storage stand-in seeded with the sample playlists, so it runs in any browser.
// Every path serves index.html (see vercel.json), like the local demo server, because the content script navigates.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot, samplePlaylists } from "../seed.mjs";

const out = path.join(repoRoot, "dist/web");
const read = (file) => readFile(path.join(repoRoot, file), "utf8");
// Keeps a "</script>" inside a source file from closing the inline tag.
const inline = (code) => code.replaceAll("</script", "<\\/script");

// chrome.storage.sync and openOptionsPage, kept in localStorage so the options page and the feed share favorites.
const chromeStandIn = `
(() => {
  const KEY = "better-youtube-demo";
  const seed = { favoritePlaylists: ${JSON.stringify(samplePlaylists)} };
  const load = () => { try { return { ...seed, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return { ...seed }; } };
  const listeners = [];
  window.chrome = {
    storage: {
      sync: {
        async get(defaults) {
          const data = load();
          return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, data[key] ?? fallback]));
        },
        async set(values) {
          const before = load();
          try { localStorage.setItem(KEY, JSON.stringify({ ...before, ...values })); } catch {}
          const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: before[key], newValue }]));
          for (const listener of listeners) listener(changes, "sync");
        },
      },
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
    runtime: { async openOptionsPage() { location.href = "/options.html"; } },
  };
})();`;

const bannerStyle = `
  html { font-size: 10px; } /* YouTube's root size, which the extension's rem values assume */
  #demo-banner { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; justify-content: center; padding: 10px 16px;
    background: #ffd166; color: #1b1b1b; font: 14px/1.4 Roboto, Arial, sans-serif; text-align: center; }
  #demo-banner a { color: inherit; font-weight: 600; }
  @media (max-width: 760px) {
    ytd-guide-renderer { width: 120px; } ytd-guide-entry-renderer { padding: 10px 12px; } ytd-guide-renderer .ytqf-guide-playlists-button { gap: 12px; }
    main { min-width: 0; padding: 16px; } ytd-rich-grid-renderer { grid-template-columns: 1fr; } }`;

const banner = (extra = "") => `
  <div id="demo-banner">
    <span><strong>Better Youtube live demo.</strong> A simulated feed with invented videos, not YouTube. Nothing leaves your browser.${extra}</span>
    <a href="https://github.com/Soleone/better-youtube">Get the extension</a>
  </div>`;

let page = await read("demo/fixture/index.html");
page = page
  .replace("<title>YouTube</title>", "<title>Better Youtube live demo</title>")
  .replace(`<span class="logo">YouTube</span>`, `<span class="logo">Demo feed</span>`)
  .replace("</style>", `${bannerStyle}\n  </style>\n  <style>\n${await read("content.css")}\n  </style>`)
  .replace("<body>", `<body>${banner(" Click <strong>Quick add</strong> on a video, or open <strong>Playlists</strong> in the sidebar.")}`)
  .replace(
    /<\/body>/,
    `  <script>${chromeStandIn}</script>\n  <script>\n${inline(await read("bridge.js"))}\n  </script>\n  <script>\n// The extension runs this in its own isolated world; the wrapper keeps it apart from the page script the same way.\n(() => {\n${inline(await read("content.js"))}\n})();\n  </script>\n</body>`
  );

let options = await read("options.html");
options = options
  .replace("<title>Better Youtube - Options</title>", "<title>Better Youtube options (demo)</title>")
  .replace(`<link rel="stylesheet" href="options.css" />`, `<style>\n${await read("options.css")}\n${bannerStyle}\n    </style>`)
  .replace("<body>", `<body>${banner(` <a href="/">Back to the feed</a>`)}`)
  .replace(`<script src="options.js"></script>`, `<script>${chromeStandIn}</script>\n    <script>\n${inline(await read("options.js"))}\n    </script>`);

await mkdir(out, { recursive: true });
await writeFile(path.join(out, "index.html"), page);
await writeFile(path.join(out, "options.html"), options);
await writeFile(path.join(out, "vercel.json"), JSON.stringify({ rewrites: [{ source: "/((?!options\\.html).*)", destination: "/index.html" }] }, null, 2));
console.log(`Wrote ${path.relative(repoRoot, out)}: index.html, options.html, vercel.json`);
