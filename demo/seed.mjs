// Shared by the demo launcher and the motion capture: sample favorites, browser flags and the extension's ID.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Invented playlists. The IDs are placeholders; the demo answers the playlist endpoint itself.
export const samplePlaylists = [
  { id: "PLdemoWatchLater0000000000000001", title: "Watch later", pinned: true },
  { id: "PLdemoWoodworking00000000000002", title: "Woodworking" },
  { id: "PLdemoBakingNotes000000000000003", title: "Baking notes" },
];

// Chrome's ID for an unpacked extension: the first 16 bytes of SHA-256 over its absolute path, each nibble written as a to p.
export function extensionId(directory = repoRoot) {
  const digest = createHash("sha256").update(realpathSync(directory)).digest("hex").slice(0, 32);
  return [...digest].map((nibble) => String.fromCharCode("a".charCodeAt(0) + parseInt(nibble, 16))).join("");
}

// Points www.youtube.com at the local server and accepts its throwaway certificate.
export function browserArgs(port) {
  return [`--host-resolver-rules=MAP www.youtube.com:443 127.0.0.1:${port}`, "--ignore-certificate-errors"];
}

// Runs in the extension's options page, where chrome.storage is available. The content script reads the same key.
export const seedExpression = `chrome.storage.sync.set({ favoritePlaylists: ${JSON.stringify(samplePlaylists)} }).then(() => "seeded")`;
