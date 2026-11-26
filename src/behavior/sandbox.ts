import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * v0.4 behaviour sandbox. Generated inputs are run against old and new versions of a function in a separate
 * Node process started with the permission model (`--permission`: no file system, no child processes, no
 * workers, no native addons), inside a fresh `vm` context with a frozen clock and seeded Math.random, and with
 * every import replaced by a recording stub. Each job (one function on all its inputs) has a timeout of 20 ms + 5 ms per input, capped at 300 ms, and the whole child a wall-clock
 * budget (CTC_BEHAVIOR_BUDGET_MS, default 400 ms); on timeout the check is skipped, never guessed.
 * The permission model does not restrict network sockets (Node <= 24), so the child also strips fetch, require,
 * process.getBuiltinModule and bindings, and the vm context gets no host-realm objects (closing the
 * constructor.constructor escape). Residual risk: vm is not a security boundary against V8 bugs; CTC_BEHAVIOR=off
 * disables the sandbox entirely for repos that treat agent-written code as hostile.
 */

export interface SandboxModule {
  /** CommonJS JavaScript (imports become require() calls, which return stubs). */
  code: string;
  /** Top-level bindings to expose (functions, consts, classes). */
  names: string[];
}

export interface SandboxJob {
  module: number;
  /** ["fn"] for a top-level function, ["Class", "method"] for a prototype method, ["Class", "static", "m"] for a static one. */
  ref: string[];
  /** Encoded argument tuples (see encodeValue). */
  inputs: string[];
}

export interface SandboxResult {
  ok: boolean;
  reason?: string;
  /** Per job: null when the module failed to load or the ref is missing; else one [serialized, truthy] per input. */
  outputs: Array<Array<[string, boolean]> | null>;
  elapsedMs: number;
}

export type Encodable = string | number | boolean | null | undefined | Date | Encodable[] | { $stub: string };

/** JSON with tags for the values JSON cannot carry. */
export function encodeValue(value: Encodable): unknown {
  if (value === undefined) return { $u: 1 };
  if (typeof value === "number" && !Number.isFinite(value)) return { $n: String(value) };
  if (value instanceof Date) return { $d: value.toISOString() };
  if (Array.isArray(value)) return value.map((item) => encodeValue(item));
  return value;
}

export function encodeArgs(args: readonly Encodable[]): string {
  return JSON.stringify(args.map((arg) => encodeValue(arg)));
}

const CONTEXT_PRELUDE = String.raw`
"use strict";
const __RealDate = Date;
const __FIXED = 1767225600000;
class __FrozenDate extends __RealDate {
  constructor(...args) { if (args.length === 0) super(__FIXED); else super(...args); }
  static now() { return __FIXED; }
}
globalThis.Date = __FrozenDate;
let __seed = 1234567;
Math.random = () => { __seed = (__seed * 16807) % 2147483647; return (__seed - 1) / 2147483646; };
const __STUB = Symbol("stub");
function __ser(v, depth, seen) {
  if (v === undefined) return "u";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (t === "string") return JSON.stringify(v);
  if (t === "boolean") return String(v);
  if (t === "bigint") return v + "n";
  if (t === "symbol") return "symbol";
  if (t === "function" && v[__STUB]) return "stub:" + v[__STUB];
  if (t === "function") return "fn";
  if (depth > 5) return "…";
  if (seen.has(v)) return "cycle";
  seen.add(v);
  const tag = Object.prototype.toString.call(v);
  let out;
  if (tag === "[object Date]") out = "Date(" + (Number.isNaN(v.getTime()) ? "Invalid" : new __RealDate(v.getTime()).toISOString()) + ")";
  else if (tag === "[object RegExp]") out = String(v);
  else if (tag === "[object Promise]") out = "promise";
  else if (Array.isArray(v)) out = "[" + v.map((x) => __ser(x, depth + 1, seen)).join(",") + "]";
  else if (tag === "[object Map]") out = "Map{" + [...v.entries()].map(([k, x]) => __ser(k, depth + 1, seen) + "=>" + __ser(x, depth + 1, seen)).join(",") + "}";
  else if (tag === "[object Set]") out = "Set{" + [...v.values()].map((x) => __ser(x, depth + 1, seen)).join(",") + "}";
  else out = "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + __ser(v[k], depth + 1, seen)).join(",") + "}";
  seen.delete(v);
  return out;
}
function __stub(label) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, key) {
      if (key === __STUB) return label;
      if (key === Symbol.toPrimitive || key === "toString" || key === "valueOf") return () => "«" + label + "»";
      if (key === "then" || typeof key === "symbol") return undefined;
      return __stub(label + "." + String(key));
    },
    apply(_t, _this, args) { return __stub(label + "(" + args.map((a) => __ser(a, 0, new Set())).join(",") + ")"); },
    construct(_t, args) { return __stub("new " + label + "(" + args.map((a) => __ser(a, 0, new Set())).join(",") + ")"); },
    set() { return true; },
    has() { return true; },
  });
}
function __decode(x) {
  if (Array.isArray(x)) return x.map(__decode);
  if (x && typeof x === "object") {
    if ("$u" in x) return undefined;
    if ("$n" in x) return Number(x.$n);
    if ("$d" in x) return new Date(x.$d);
    if ("$stub" in x) return __stub(x.$stub);
  }
  return x;
}
globalThis.__ctc = { ser: __ser, stub: __stub, decode: __decode, registry: null };
`;

const CALL_SCRIPT = String.raw`(() => {
  const c = globalThis.__ctc;
  return JSON.parse(c.inputs).map((argsJson) => {
    const args = c.decode(JSON.parse(argsJson));
    let value, threw = null;
    try { value = c.fn.apply(c.self, args); } catch (e) { threw = (e && e.name) || "Error"; }
    if (threw !== null) return ["throw:" + threw, false];
    return [c.ser(value, 0, new Set()), Boolean(value)];
  });
})()`;

/**
 * Runs inside the child: plain JavaScript. One request per stdin line, one response per stdout line, so the same
 * child can serve many checks (the long-lived bridge below) or exactly one (the spawnSync fallback). Compiled
 * module scripts are cached by source; every request still gets fresh contexts, so no state leaks between checks.
 */
const CHILD = String.raw`
const vm = require("node:vm");
// Defence in depth: take what the child needs, then strip every host capability that reaches the network or
// loads modules, so even a vm escape finds no fetch, no require, no getBuiltinModule and no bindings.
const __stdin = process.stdin, __stdout = process.stdout, __exit = process.exit.bind(process);
for (const k of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "require", "module", "exports", "__filename", "__dirname"]) {
  try { delete globalThis[k]; } catch (e) {}
  try { if (k in globalThis) Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
}
for (const k of ["getBuiltinModule", "binding", "_linkedBinding", "dlopen", "mainModule", "openStdin", "kill", "reallyExit", "abort", "chdir"]) {
  try { Object.defineProperty(process, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
}
// A context whose global has no host-realm prototype chain: DONT_CONTEXTIFY where available (Node >= 22.8),
// otherwise a null-prototype sandbox. No host object is ever handed into the context.
const __mkContext = () => vm.createContext(vm.constants && vm.constants.DONT_CONTEXTIFY !== undefined ? vm.constants.DONT_CONTEXTIFY : Object.create(null));
const scripts = new Map();
let prelude = null, callScript = null;
function compiled(code) {
  let hit = scripts.get(code);
  if (!hit) {
    hit = new vm.Script(code);
    if (scripts.size > 300) scripts.clear();
    scripts.set(code, hit);
  }
  return hit;
}
function handle(payload) {
  if (!prelude) { prelude = new vm.Script(payload.prelude); callScript = new vm.Script(payload.call); }
  const contexts = payload.modules.map((mod) => {
    try {
      const ctx = __mkContext();
      prelude.runInContext(ctx, { timeout: 200 });
      const wrapper = "(function (exports, require, module) {\n" + mod.code + "\n;globalThis.__ctc.registry = {" +
        mod.names.map((n) => JSON.stringify(n) + ": (typeof " + n + " === 'undefined' ? undefined : " + n + ")").join(",") + "};\n})";
      const fn = compiled(wrapper).runInContext(ctx, { timeout: 200 });
      const stubRequire = vm.runInContext("(spec) => globalThis.__ctc.stub('import:' + spec)", ctx);
      vm.runInContext("(f, r) => { const m = { exports: {} }; f(m.exports, r, m); }", ctx)(fn, stubRequire);
      return ctx;
    } catch (e) {
      return null;
    }
  });
  return payload.jobs.map((job) => {
    const ctx = contexts[job.module];
    if (!ctx) return null;
    const c = vm.runInContext("globalThis.__ctc", ctx);
    const reg = c.registry || {};
    let fn, self;
    try {
      if (job.ref.length === 1) { fn = reg[job.ref[0]]; self = undefined; }
      else if (job.ref[1] === "static") { fn = reg[job.ref[0]] && reg[job.ref[0]][job.ref[2]]; self = reg[job.ref[0]]; }
      else { fn = reg[job.ref[0]] && reg[job.ref[0]].prototype && reg[job.ref[0]].prototype[job.ref[1]]; self = c.stub("this"); }
    } catch (e) { fn = undefined; }
    if (typeof fn !== "function") return null;
    c.fn = fn; c.self = self; c.inputs = JSON.stringify(job.inputs);
    try { return callScript.runInContext(ctx, { timeout: Math.min(300, 20 + 5 * job.inputs.length) }); }
    catch (e) { return job.inputs.map(() => ["timeout", false]); }
  });
}
let input = "";
__stdin.setEncoding("utf8");
__stdin.on("data", (d) => {
  input += d;
  let i;
  while ((i = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, i);
    input = input.slice(i + 1);
    let out;
    try { out = JSON.stringify({ ok: true, outputs: handle(JSON.parse(line)) }); }
    catch (e) { out = JSON.stringify({ ok: false, reason: String(e && e.message || e) }); }
    __stdout.write(out + "\n");
  }
});
__stdin.on("end", () => __exit(0));
`;

/**
 * Worker thread that owns one long-lived sandbox child. The gate is synchronous, so the caller blocks on
 * Atomics.wait and then takes the reply with receiveMessageOnPort (no event-loop turn needed). Saves the ~40 ms
 * Node start-up and the module compile on every check after the first.
 */
const BRIDGE = String.raw`
const { workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { port, flag, exec, args, path } = workerData;
const signal = new Int32Array(flag);
let child = null, buf = "", pending = null;
function finish(result) {
  const p = pending; pending = null;
  if (!p) return;
  clearTimeout(p.timer);
  port.postMessage(result);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}
function ensure() {
  if (child) return;
  child = spawn(exec, args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: path } });
  buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); finish({ line }); }
  });
  child.stdin.on("error", () => {});
  child.on("exit", () => { child = null; finish({ error: "sandbox exited" }); });
  child.on("error", () => { child = null; finish({ error: "sandbox failed to start" }); });
}
port.on("message", ({ request, budget }) => {
  try { ensure(); } catch (e) { pending = { timer: null }; finish({ error: String(e) }); return; }
  pending = { timer: setTimeout(() => { const c = child; child = null; if (c) c.kill("SIGKILL"); finish({ error: "budget exceeded" }); }, budget) };
  child.stdin.write(request + "\n");
});
`;

interface Bridge {
  port: import("node:worker_threads").MessagePort;
  signal: Int32Array;
  broken: boolean;
}
let bridge: Bridge | null = null;

/** `--permission` is stable from Node 22.13 / 23.5; Node 20 and early 22 only know `--experimental-permission`. */
export function permissionFlag(flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): string {
  return flags.has("--permission") ? "--permission" : "--experimental-permission";
}

function childArgs(): string[] {
  return [permissionFlag(), "--no-warnings", "--max-old-space-size=128", "-e", CHILD];
}

function getBridge(): Bridge | null {
  if (bridge) return bridge.broken ? null : bridge;
  if (process.env.CTC_BEHAVIOR_PERSISTENT === "0") return null;
  try {
    const { Worker, MessageChannel } = require_("node:worker_threads") as typeof import("node:worker_threads");
    const { port1, port2 } = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    const worker = new Worker(BRIDGE, { eval: true, workerData: { port: port2, flag, exec: process.execPath, args: childArgs(), path: process.env.PATH ?? "" }, transferList: [port2] });
    worker.unref();
    port1.unref();
    worker.on("error", () => {
      if (bridge) bridge.broken = true;
    });
    bridge = { port: port1, signal: new Int32Array(flag), broken: false };
    return bridge;
  } catch {
    return null;
  }
}

export function behaviorEnabled(): boolean {
  return process.env.CTC_BEHAVIOR !== "off" && process.env.CTC_BEHAVIOR !== "0";
}

export function budgetMs(): number {
  const raw = Number(process.env.CTC_BEHAVIOR_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 400;
}

export function runSandbox(modules: SandboxModule[], jobs: SandboxJob[]): SandboxResult {
  const started = Date.now();
  if (jobs.length === 0) return { ok: true, outputs: [], elapsedMs: 0 };
  const request = JSON.stringify({ prelude: CONTEXT_PRELUDE, call: CALL_SCRIPT, modules, jobs });
  const budget = budgetMs();
  const live = getBridge();
  let line: string | null = null;
  let failure: string | null = null;
  if (live) {
    const { receiveMessageOnPort } = require_("node:worker_threads") as typeof import("node:worker_threads");
    Atomics.store(live.signal, 0, 0);
    live.port.postMessage({ request, budget });
    // First call also pays worker + child start-up, so allow it a little longer.
    const waited = Atomics.wait(live.signal, 0, 0, budget + 1500);
    const reply = receiveMessageOnPort(live.port)?.message as { line?: string; error?: string } | undefined;
    if (waited === "timed-out" || !reply) {
      live.broken = true;
      failure = "sandbox bridge did not answer";
    } else if (reply.error) failure = reply.error;
    else line = reply.line ?? null;
  } else {
    const child = spawnSync(process.execPath, childArgs(), {
      input: `${request}\n`,
      encoding: "utf8",
      timeout: budget,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "" },
    });
    if (child.error || child.status !== 0) failure = child.error ? child.error.message : `exit ${child.status}`;
    else line = child.stdout.split("\n")[0] ?? null;
  }
  const elapsedMs = Date.now() - started;
  if (failure !== null || line === null) return { ok: false, reason: failure ?? "no output", outputs: [], elapsedMs };
  try {
    const parsed = JSON.parse(line) as { ok: boolean; reason?: string; outputs?: SandboxResult["outputs"] };
    if (!parsed.ok || !parsed.outputs) return { ok: false, reason: parsed.reason ?? "sandbox error", outputs: [], elapsedMs };
    return { ok: true, outputs: parsed.outputs, elapsedMs };
  } catch {
    return { ok: false, reason: "unreadable sandbox output", outputs: [], elapsedMs };
  }
}
