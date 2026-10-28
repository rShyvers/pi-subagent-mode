#!/usr/bin/env node
/**
 * model-gate: a tiny reverse proxy that decides which models may run at the same time.
 *
 * Put it in front of an OpenAI-compatible server (for example Unsloth) that can only
 * keep ONE model active at a time. Point your Pi provider's baseUrl at the gate
 * instead of the server.
 *
 *   mode "all"        every request goes straight through (optionally capped)
 *   mode "one-model"  only one model is active at any moment. Requests for the active
 *                     model run together; requests for other models wait. When the
 *                     active group finishes, the next group (the model at the head of
 *                     the queue, plus every other queued request for that same model)
 *                     is released. Models are never mixed, so the server is never
 *                     asked to swap models while work is in flight.
 *
 * The gate never loads or unloads models. It only orders requests.
 *
 * Usage:
 *   node model-gate.mjs --upstream http://127.0.0.1:8000 [--listen 8081] [--host 127.0.0.1]
 *        [--mode one-model|all] [--per-model-cap N] [--max-concurrent N]
 *        [--queue-timeout-ms 1800000] [--admin-token SECRET] [--log]
 *
 *   --upstream        server origin WITHOUT a /v1 suffix (the gate forwards paths as received)
 *   --per-model-cap   max simultaneous requests for the active model (0 = unlimited, default)
 *   --max-concurrent  mode "all" only: max simultaneous requests (0 = unlimited, default)
 *
 * Admin API (loopback only unless --admin-token is set):
 *   GET  /__gate/status
 *   POST /__gate/mode   {"mode":"one-model"|"all","perModelCap":N,"maxConcurrent":N}
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Only requests to these endpoints that carry a JSON "model" field are gated.
const GATED = /\/(chat\/completions|completions|responses|embeddings|messages)(\?|$)/;

export function createGate(opts) {
  const cfg = {
    mode: opts.mode === "all" ? "all" : "one-model",
    perModelCap: Number(opts.perModelCap) || 0,
    maxConcurrent: Number(opts.maxConcurrent) || 0,
    queueTimeoutMs: opts.queueTimeoutMs === undefined ? 1_800_000 : Number(opts.queueTimeoutMs),
  };
  const up = new URL(opts.upstream);
  const upBase = up.pathname.replace(/\/+$/, "");
  const lib = up.protocol === "https:" ? https : http;
  const loopbackBind = ["127.0.0.1", "::1", "localhost"].includes(opts.host ?? "127.0.0.1");
  const log = (...a) => opts.log && console.error(new Date().toISOString(), "[gate]", ...a);

  let activeModel = null;
  let activeTotal = 0;
  const activeByModel = new Map();
  const queue = [];

  const canJoinGroup = (model) => !cfg.perModelCap || (activeByModel.get(model) ?? 0) < cfg.perModelCap;

  function start(entry) {
    activeModel = entry.model;
    activeTotal++;
    activeByModel.set(entry.model, (activeByModel.get(entry.model) ?? 0) + 1);
    if (entry.timer) clearTimeout(entry.timer);
    log("admit", entry.model, `active=${activeTotal}`, `queued=${queue.length}`);
    entry.admit();
  }

  function pump() {
    if (cfg.mode === "all") {
      while (queue.length && (!cfg.maxConcurrent || activeTotal < cfg.maxConcurrent)) start(queue.shift());
      return;
    }
    if (activeTotal === 0 && queue.length) {
      // Idle: the model at the head of the queue wins; release all queued requests for it.
      const model = queue[0].model;
      for (let i = 0; i < queue.length; ) {
        if (queue[i].model === model && canJoinGroup(model)) start(queue.splice(i, 1)[0]);
        else i++;
      }
      return;
    }
    // A group is running: only requests for that model at the very front may join.
    // As soon as another model is waiting at the front, no more are admitted (no starvation).
    while (queue.length && queue[0].model === activeModel && canJoinGroup(activeModel)) start(queue.shift());
  }

  function release(model) {
    activeTotal = Math.max(0, activeTotal - 1);
    const n = (activeByModel.get(model) ?? 1) - 1;
    if (n <= 0) activeByModel.delete(model);
    else activeByModel.set(model, n);
    if (activeTotal === 0) activeModel = null;
    log("release", model, `active=${activeTotal}`, `queued=${queue.length}`);
    pump();
  }

  const status = () => ({
    mode: cfg.mode,
    perModelCap: cfg.perModelCap,
    maxConcurrent: cfg.maxConcurrent,
    upstream: opts.upstream,
    activeModel,
    active: Object.fromEntries(activeByModel),
    queued: queue.map((q) => q.model),
  });

  function adminAllowed(req) {
    if (opts.adminToken) return req.headers["x-gate-token"] === opts.adminToken;
    return loopbackBind;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async function admin(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (!adminAllowed(req)) return send(403, { error: "admin API disabled (bind to loopback or set --admin-token)" });
    if (req.method === "GET" && req.url.startsWith("/__gate/status")) return send(200, status());
    if (req.method === "POST" && req.url.startsWith("/__gate/mode")) {
      let b;
      try {
        b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      } catch {
        return send(400, { error: "invalid JSON" });
      }
      if (b.mode !== undefined) {
        if (b.mode !== "all" && b.mode !== "one-model") return send(400, { error: 'mode must be "all" or "one-model"' });
        cfg.mode = b.mode;
      }
      if (b.perModelCap !== undefined) cfg.perModelCap = Math.max(0, Number(b.perModelCap) || 0);
      if (b.maxConcurrent !== undefined) cfg.maxConcurrent = Math.max(0, Number(b.maxConcurrent) || 0);
      log("config", JSON.stringify(cfg));
      pump(); // a looser setting may release waiting requests immediately
      return send(200, status());
    }
    return send(404, { error: "unknown admin route" });
  }

  function forward(req, res, body, model) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (model !== null) release(model);
    };
    const headers = { ...req.headers, host: up.host, "content-length": String(body.length) };
    delete headers["transfer-encoding"];
    const preq = lib.request(
      {
        hostname: up.hostname,
        port: up.port || (up.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: upBase + req.url,
        headers,
      },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
        pres.on("end", finish);
        pres.on("error", () => {
          finish();
          res.destroy();
        });
      },
    );
    preq.on("error", (err) => {
      log("upstream error", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `model-gate: upstream error: ${err.message}` } }));
      } else res.destroy();
      finish();
    });
    // Client went away (or finished): stop the upstream request and free the slot.
    res.on("close", () => {
      if (!done) preq.destroy();
      finish();
    });
    preq.end(body);
  }

  async function handle(req, res) {
    if (req.url.startsWith("/__gate/")) return admin(req, res);

    const body = await readBody(req);
    let model;
    if (req.method === "POST" && GATED.test(req.url)) {
      try {
        const m = JSON.parse(body.toString("utf8")).model;
        if (typeof m === "string" && m) model = m;
      } catch {
        // not JSON: pass through ungated
      }
    }
    if (model === undefined) return forward(req, res, body, null); // e.g. GET /v1/models

    const entry = { model };
    const admitted = new Promise((resolve, reject) => {
      entry.admit = resolve;
      entry.reject = reject;
    });
    if (cfg.queueTimeoutMs > 0) {
      entry.timer = setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i >= 0) {
          queue.splice(i, 1);
          entry.reject(new Error("queue timeout"));
        }
      }, cfg.queueTimeoutMs);
    }
    // Client left while still queued: drop it from the queue.
    res.on("close", () => {
      const i = queue.indexOf(entry);
      if (i >= 0) {
        queue.splice(i, 1);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error("client closed"));
        pump();
      }
    });
    queue.push(entry);
    log("queue", model, `active=${activeTotal}`, `queued=${queue.length}`);
    pump();

    try {
      await admitted;
    } catch (err) {
      if (!res.writableEnded && !res.destroyed && err.message === "queue timeout") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model-gate: timed out waiting for the active model group" } }));
      }
      return;
    }
    forward(req, res, body, model);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log("handler error", err?.message);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model-gate internal error" } }));
      } else res.destroy();
    });
  });
  return { server, status, cfg };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") o.log = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a.startsWith("--")) o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return o;
}

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.upstream) {
    console.error(
      "Usage: node model-gate.mjs --upstream http://127.0.0.1:8000 [--listen 8081] [--host 127.0.0.1]\n" +
        "       [--mode one-model|all] [--per-model-cap N] [--max-concurrent N]\n" +
        "       [--queue-timeout-ms 1800000] [--admin-token SECRET] [--log]",
    );
    process.exit(o.help ? 0 : 1);
  }
  const host = o.host ?? "127.0.0.1";
  const { server, cfg } = createGate({ ...o, host });
  const port = Number(o.listen ?? 8081);
  server.listen(port, host, () =>
    console.error(`model-gate listening on http://${host}:${port} -> ${o.upstream} (mode: ${cfg.mode})`),
  );
}
