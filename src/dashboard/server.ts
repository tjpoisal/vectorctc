import http from "node:http";

import { aggregate } from "./aggregate.js";
import path from "node:path";

import { loadReplay } from "../replay/store.js";
import { renderDashboard, renderReplayPage } from "./render.js";

/** Local-only dashboard server: binds 127.0.0.1, read-only, recomputes on every request. */
export function startDashboard(roots: readonly string[], options: { port?: number; days?: number } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const days = Number.parseInt(url.searchParams.get("days") ?? "", 10) || options.days || 30;
    if (url.pathname === "/api/summary") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(aggregate(roots, { days }), null, 2));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }).end(renderDashboard(aggregate(roots, { days }), { refreshSeconds: 15 }));
      return;
    }
    const replayRoute = /^\/replay\/(\d{1,3})\/([a-f0-9]{6,64})$/.exec(url.pathname);
    if (replayRoute) {
      const root = roots[Number(replayRoute[1])];
      const replay = root ? loadReplay(path.resolve(root), replayRoute[2]!) : null;
      if (root && replay) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }).end(renderReplayPage(replay, path.basename(path.resolve(root))));
        return;
      }
    }
    res.writeHead(404).end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4318, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : options.port ?? 4318, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
