import http from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadBlueprint } from "../blueprint/store.js";
import { applyPatchReviewed } from "../gate/apply.js";
import { anyCircuitOpen, loadState } from "../engine/circuit-breaker.js";
import { readFile } from "../radar/read.js";
import { readRadar } from "../radar/state.js";
import { createMcpServer } from "../mcp/server.js";
import { applyContentReviewed, checkFileReviewed } from "./check.js";
import { resolveContract } from "./contract.js";
import { openApiDocument } from "./openapi.js";

export interface UniversalServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://127.0.0.1",
    "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(json);
}

function authorized(req: http.IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

export async function startUniversalServer(root: string, options: { port?: number; token?: string; version?: string } = {}): Promise<UniversalServer> {
  const token = options.token !== undefined ? options.token || undefined : process.env.CTC_HTTP_TOKEN || undefined;
  const version = options.version ?? "0.1.0";
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        send(res, 204, {});
        return;
      }
      if (!authorized(req, token) && url.pathname !== "/openapi.json") {
        send(res, 401, { protocol: "ctc.error.v1", cleared: false, message: "Bearer token required." });
        return;
      }
      if (req.method === "GET" && url.pathname === "/openapi.json") {
        const host = req.headers.host ?? `127.0.0.1:${options.port ?? 0}`;
        send(res, 200, openApiDocument(`http://${host}`));
        return;
      }
      if (url.pathname === "/mcp") {
        const raw = req.method === "POST" ? await readBody(req) : "";
        let parsed: unknown;
        if (raw) {
          try {
            parsed = JSON.parse(raw) as unknown;
          } catch (error) {
            send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: error instanceof Error ? error.message : String(error) });
            return;
          }
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcp = createMcpServer(root, version);
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
        res.on("close", () => {
          void mcp.close();
          void transport.close();
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/blueprint") {
        send(res, 200, { protocol: "ctc.blueprint.v1", blueprint: loadBlueprint(root) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/status") {
        const state = loadState(root);
        const radar = readRadar(root);
        const contract = resolveContract(root);
        send(res, 200, {
          protocol: "ctc.status.v1",
          circuit: anyCircuitOpen(state) ? "open" : "closed",
          readLock: radar.locked,
          contract: contract.ok ? contract.source : contract.error,
          flightPlan: contract.ok ? { taskId: contract.plan.taskId, allowedFileGlobs: contract.plan.allowedFileGlobs } : null,
        });
        return;
      }
      if (req.method !== "POST" || !url.pathname.startsWith("/v1/")) {
        send(res, 404, { protocol: "ctc.error.v1", cleared: false, message: `No route for ${req.method ?? "GET"} ${url.pathname}` });
        return;
      }
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object.");
          body = parsed as Record<string, unknown>;
        } catch (error) {
          send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      const filePath = typeof body.path === "string" ? body.path : "";
      if (url.pathname === "/v1/check") {
        if (!filePath) {
          send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: "path is required." });
          return;
        }
        const outcome = await checkFileReviewed(root, filePath, typeof body.content === "string" ? body.content : undefined);
        const status = outcome.exitCode === 0 ? 200 : outcome.exitCode === 2 ? 409 : 400;
        send(res, status, outcome.payload);
        return;
      }
      if (url.pathname === "/v1/write") {
        if (!filePath || typeof body.content !== "string") {
          send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: "path and content are required." });
          return;
        }
        const outcome = await applyContentReviewed(root, filePath, body.content, typeof body.sessionId === "string" ? body.sessionId : undefined);
        send(res, outcome.exitCode === 0 ? 200 : outcome.exitCode === 2 ? 409 : 400, outcome);
        return;
      }
      if (url.pathname === "/v1/patch") {
        if (!filePath || !Array.isArray(body.hunks)) {
          send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: "path and hunks are required." });
          return;
        }
        const hunks = body.hunks.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as { search?: unknown; replace?: unknown };
          if (typeof record.search !== "string" || typeof record.replace !== "string") return [];
          return [{ search: record.search, replace: record.replace }];
        });
        if (hunks.length === 0) {
          send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: "hunks need string search and replace fields." });
          return;
        }
        const contract = resolveContract(root);
        if (!contract.ok) {
          send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: contract.error });
          return;
        }
        const result = await applyPatchReviewed(root, {
          path: filePath,
          hunks,
          plan: contract.plan,
          ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        });
        send(res, result.cleared ? 200 : 409, result);
        return;
      }
      if (url.pathname === "/v1/read") {
        if (!filePath) {
          send(res, 400, { protocol: "ctc.error.v1", cleared: false, message: "path is required." });
          return;
        }
        const result = readFile(root, {
          path: filePath,
          ...(typeof body.startLine === "number" ? { startLine: body.startLine } : {}),
          ...(typeof body.endLine === "number" ? { endLine: body.endLine } : {}),
          ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        });
        send(res, result.cleared ? 200 : 409, result);
        return;
      }
      send(res, 404, { protocol: "ctc.error.v1", cleared: false, message: `Unknown path ${url.pathname}` });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { protocol: "ctc.error.v1", cleared: false, message: error instanceof Error ? error.message : String(error) });
    }
  });
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: bound,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
