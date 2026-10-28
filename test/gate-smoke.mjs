// Smoke tests for bin/model-gate.mjs using a mock upstream. Run: node test/gate-smoke.mjs
import http from "node:http";
import { createGate } from "../bin/model-gate.mjs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// ---- mock upstream: records which models are active at once -----------------
function makeUpstream() {
  const active = new Map();
  const log = []; // "start:model" / "end:model"
  const stats = { maxDistinct: 0, maxPerModel: {}, hits: 0 };
  const srv = http.createServer(async (req, res) => {
    stats.hits++;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let b = {};
    try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {}
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"data":[]}'); }
    const m = b.model;
    active.set(m, (active.get(m) ?? 0) + 1);
    log.push("start:" + m);
    stats.maxDistinct = Math.max(stats.maxDistinct, active.size);
    stats.maxPerModel[m] = Math.max(stats.maxPerModel[m] ?? 0, active.get(m));
    const done = () => {
      const n = (active.get(m) ?? 1) - 1;
      n <= 0 ? active.delete(m) : active.set(m, n);
      log.push("end:" + m);
    };
    res.on("close", done);
    if (b.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 3; i++) { res.write(`data: {"i":${i}}\n\n`); await sleep(40); }
      res.end("data: [DONE]\n\n");
    } else {
      await sleep(b._delay ?? 150);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, model: m }));
    }
  });
  return { srv, active, log, stats };
}

const post = (port, body, path = "/v1/chat/completions") =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(data);
  });
const get = (port, path) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });

async function withGate(opts, fn) {
  const up = makeUpstream();
  const upPort = await listen(up.srv);
  const gate = createGate({ upstream: `http://127.0.0.1:${upPort}`, host: "127.0.0.1", ...opts });
  const port = await listen(gate.server);
  try { await fn({ port, up, gate }); }
  finally { gate.server.closeAllConnections?.(); gate.server.close(); up.srv.closeAllConnections?.(); up.srv.close(); }
}

// 1. mode "all": different models overlap
await withGate({ mode: "all" }, async ({ port, up }) => {
  await Promise.all([post(port, { model: "qwen" }), post(port, { model: "granite" })]);
  check('mode "all" lets two models overlap', up.stats.maxDistinct === 2, `maxDistinct=${up.stats.maxDistinct}`);
});

// 2. one-model: never two models at once; same-model requests run together
await withGate({ mode: "one-model" }, async ({ port, up }) => {
  const reqs = ["qwen", "qwen", "qwen", "granite", "granite"].map((m) => post(port, { model: m }));
  const out = await Promise.all(reqs);
  check("one-model: all 5 requests succeed", out.every((o) => o.status === 200));
  check("one-model: never two models active at once", up.stats.maxDistinct === 1, `maxDistinct=${up.stats.maxDistinct}`);
  check("one-model: same-model requests ran together (qwen x3)", up.stats.maxPerModel.qwen === 3, `qwen peak=${up.stats.maxPerModel.qwen}`);
  check("one-model: granite group ran together (x2)", up.stats.maxPerModel.granite === 2);
  const firstGraniteStart = up.log.indexOf("start:granite");
  const lastQwenEnd = up.log.lastIndexOf("end:qwen");
  check("one-model: groups are sequential (qwen finished before granite started)", lastQwenEnd < firstGraniteStart, up.log.join(","));
});

// 3. interleaved arrival Q1,G1,Q2: no starvation, groups switch in arrival order
await withGate({ mode: "one-model" }, async ({ port, up }) => {
  const p1 = post(port, { model: "qwen", _delay: 200 });
  await sleep(30);
  const p2 = post(port, { model: "granite", _delay: 100 });
  await sleep(30);
  const p3 = post(port, { model: "qwen", _delay: 100 });
  await Promise.all([p1, p2, p3]);
  const starts = up.log.filter((e) => e.startsWith("start:")).map((e) => e.slice(6));
  check("interleaved: order is qwen, granite, qwen (late qwen waits behind waiting granite)", starts.join(",") === "qwen,granite,qwen", starts.join(","));
  check("interleaved: never mixed", up.stats.maxDistinct === 1);
});

// 4. per-model cap 1 = fully serial
await withGate({ mode: "one-model", perModelCap: 1 }, async ({ port, up }) => {
  await Promise.all([post(port, { model: "qwen" }), post(port, { model: "qwen" }), post(port, { model: "qwen" })]);
  check("per-model-cap=1: same-model requests are serialised", up.stats.maxPerModel.qwen === 1, `peak=${up.stats.maxPerModel.qwen}`);
});

// 5. streaming passes through intact
await withGate({ mode: "one-model" }, async ({ port }) => {
  const r = await post(port, { model: "qwen", stream: true });
  check("streaming (SSE) passes through", r.status === 200 && r.body.includes('"i":2') && r.body.includes("[DONE]"));
});

// 6. non-gated routes are not blocked by an active group
await withGate({ mode: "one-model" }, async ({ port }) => {
  const slow = post(port, { model: "qwen", _delay: 400 });
  await sleep(50);
  const t0 = Date.now();
  const r = await get(port, "/v1/models");
  check("GET /v1/models is not queued behind an active model", r.status === 200 && Date.now() - t0 < 200);
  await slow;
});

// 7. client aborts while queued: removed from queue, others unaffected
await withGate({ mode: "one-model" }, async ({ port, up, gate }) => {
  const first = post(port, { model: "qwen", _delay: 300 });
  await sleep(40);
  const data = JSON.stringify({ model: "granite" });
  const abortedReq = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } });
  abortedReq.on("error", () => {});
  abortedReq.end(data);
  await sleep(60);
  check("queued request visible in status", gate.status().queued.join() === "granite");
  abortedReq.destroy();
  await sleep(60);
  check("aborted queued request removed from queue", gate.status().queued.length === 0);
  await first;
  check("aborted request never reached upstream", !up.log.includes("start:granite"));
});

// 8. upstream down -> 502, and the slot is released for later requests
{
  const gate = createGate({ upstream: "http://127.0.0.1:1", host: "127.0.0.1" });
  const port = await listen(gate.server);
  const r1 = await post(port, { model: "qwen" });
  const r2 = await post(port, { model: "granite" });
  check("upstream down returns 502", r1.status === 502);
  check("slot released after upstream error (next request not stuck)", r2.status === 502);
  check("gate idle after errors", gate.status().activeModel === null && gate.status().queued.length === 0);
  gate.server.close();
}

// 9. admin API: switch mode mid-run; loosening releases waiting requests
await withGate({ mode: "one-model" }, async ({ port, up }) => {
  const a = post(port, { model: "qwen", _delay: 500 });
  await sleep(40);
  const b = post(port, { model: "granite", _delay: 100 });
  await sleep(60);
  const before = up.stats.maxDistinct;
  const sw = await post(port, { mode: "all" }, "/__gate/mode");
  await Promise.all([a, b]);
  check("admin switch to all released the waiting model immediately", before === 1 && up.stats.maxDistinct === 2 && JSON.parse(sw.body).mode === "all");
  const st = await get(port, "/__gate/status");
  check("admin status reports mode", JSON.parse(st.body).mode === "all");
  const bad = await post(port, { mode: "nonsense" }, "/__gate/mode");
  check("admin rejects invalid mode", bad.status === 400);
});

// 10. admin API is disabled on non-loopback binds without a token
{
  const gate = createGate({ upstream: "http://127.0.0.1:1", host: "0.0.0.0" });
  const port = await listen(gate.server);
  const r = await get(port, "/__gate/status");
  check("admin disabled on 0.0.0.0 without token", r.status === 403);
  gate.server.close();
}
{
  const gate = createGate({ upstream: "http://127.0.0.1:1", host: "0.0.0.0", adminToken: "s3cret" });
  const port = await listen(gate.server);
  const noTok = await get(port, "/__gate/status");
  const withTok = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/__gate/status", headers: { "x-gate-token": "s3cret" } }, (res) => { res.resume(); resolve(res.statusCode); }));
  check("admin on 0.0.0.0 requires the token", noTok.status === 403 && withTok === 200);
  gate.server.close();
}

// 11. client aborts an ACTIVE request: upstream is cancelled and the next group is released
await withGate({ mode: "one-model" }, async ({ port, up, gate }) => {
  const data = JSON.stringify({ model: "qwen", _delay: 5000 });
  const longReq = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } });
  longReq.on("error", () => {});
  longReq.end(data);
  await sleep(80);
  const next = post(port, { model: "granite", _delay: 50 });
  await sleep(60);
  check("granite waits while long qwen request is active", gate.status().queued.join() === "granite");
  const t0 = Date.now();
  longReq.destroy();
  const r = await next;
  check("aborting the active request frees the slot and releases the next group", r.status === 200 && Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
  check("upstream saw the qwen request end", up.log.includes("end:qwen"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
