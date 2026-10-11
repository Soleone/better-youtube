// Serves the synthetic YouTube page over HTTPS so the extension's content scripts run on the host they match.
// Browsers are pointed at it with --host-resolver-rules (see demo/chrome-args.mjs), so www.youtube.com resolves here.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixture");

// A throwaway certificate for www.youtube.com, made per run so no private key is committed.
async function makeCertificate() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "better-youtube-demo-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  await exec("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath,
    "-subj", "/CN=www.youtube.com", "-addext", "subjectAltName=DNS:www.youtube.com",
  ]).catch((error) => {
    throw new Error(`openssl is needed to make the demo certificate: ${error.message}`);
  });
  return { dir, key: await readFile(keyPath), cert: await readFile(certPath) };
}

// Every path returns the page, because YouTube is a single page app and the content scripts run on each route.
export async function startServer({ port = 0 } = {}) {
  const tls = await makeCertificate();
  const page = await readFile(path.join(fixtureRoot, "index.html"));
  const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(tls.dir, { recursive: true, force: true });
    },
  };
}
