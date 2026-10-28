// Smoke tests for index.ts using a mocked ExtensionAPI. No models, no network.
// Run: node --experimental-strip-types test/extension-smoke.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
};

// Isolate config + log in a throwaway HOME so the user's real config is untouched.
const fakeHome = mkdtempSync(join(tmpdir(), "subagent-mode-test-"));
process.env.HOME = fakeHome;
delete process.env.PI_LOCAL_PROVIDERS;
delete process.env.PI_SYNC_HOOK_LOG;

const { default: makeExtension } = await import("../index.ts");
const CONFIG_PATH = join(fakeHome, ".pi", "agent", "subagent-mode.json");

function readCfg() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}
function writeCfg(obj) {
  mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
}

// Fresh extension instance with a mock ExtensionAPI; returns the registered handlers.
function makePi() {
  let toolCallHandler;
  const commands = {};
  const pi = {
    on: (event, handler) => {
      if (event === "tool_call") toolCallHandler = handler;
    },
    registerCommand: (name, opts) => {
      commands[name] = opts;
    },
  };
  makeExtension(pi);
  return { toolCallHandler, commands };
}

const ctxFor = (baseUrl, provider = "llamacpp", modelId = "unsloth/Qwen3.8-27B-GGUF") => ({
  model: { provider, id: modelId, baseUrl },
});

async function fireTool(pi, input, ctx) {
  await pi.toolCallHandler({ toolName: "subagent", input }, ctx);
  return input;
}

// ---- 1. endpoint detection -------------------------------------------------
{
  const pi = makePi();
  let in1 = { prompt: "x" };
  await fireTool(pi, in1, ctxFor("http://127.0.0.1:8888/v1"));
  check("loopback endpoint -> async:false (block)", in1.async === false);

  let in2 = { prompt: "x" };
  await fireTool(pi, in2, ctxFor("http://203.0.113.5:8000/v1")); // TEST-NET-3: public
  check("public endpoint -> async:true (remote default)", in2.async === true);

  let in3 = { prompt: "x" };
  await fireTool(pi, in3, ctxFor("http://192.168.1.50:8000/v1")); // private LAN
  check("LAN endpoint -> async:false (lan defaults to block)", in3.async === false);

  let in4 = { prompt: "x", async: true };
  await fireTool(pi, in4, ctxFor("http://203.0.113.5:8000/v1"));
  check("explicit async:true on remote is preserved (not forced false)", in4.async === true);

  let in5 = { action: "status" };
  await fireTool(pi, in5, ctxFor("http://127.0.0.1:8888/v1"));
  check("management calls (action) are never touched", in5.async === undefined);

  let in6 = { prompt: "x" };
  await fireTool(pi, in6, { model: { provider: "nope", id: "m" } }); // no baseUrl anywhere
  check("unreadable endpoint -> defaults to remote (async:true)", in6.async === true);
}

// ---- 2. provider / model rules beat detection -------------------------------
{
  writeCfg({ localProviders: ["myserver"], remoteProviders: [], mode: "auto", detect: true, lanAction: "block", forceRemoteBackground: true, log: false });
  const pi = makePi();

  let in1 = { prompt: "x" };
  await fireTool(pi, in1, ctxFor("http://203.0.113.5:8000/v1", "myserver")); // public, but pause rule
  check("pause rule beats public detection -> async:false", in1.async === false);

  let in2 = { prompt: "x" };
  await fireTool(pi, in2, ctxFor("http://127.0.0.1:8888/v1", "other")); // local, no rule
  check("unrelated provider still detected (loopback -> async:false)", in2.async === false);

  writeCfg({ localProviders: [], remoteProviders: ["myserver"], mode: "auto", detect: true, lanAction: "block", forceRemoteBackground: true, log: false });
  const pi2 = makePi();
  let in3 = { prompt: "x" };
  await fireTool(pi2, in3, ctxFor("http://127.0.0.1:8888/v1", "myserver")); // loopback, but no-pause rule
  check("no-pause rule beats local detection -> async:true", in3.async === true);

  // Specificity: provider/model rule (score 2) beats provider-only rule (score 1)
  writeCfg({ localProviders: ["prov"], remoteProviders: ["prov/special"], mode: "auto", detect: true, lanAction: "block", forceRemoteBackground: true, log: false });
  const pi3 = makePi();
  let in4 = { prompt: "x" };
  await fireTool(pi3, in4, ctxFor("http://127.0.0.1:8888/v1", "prov", "special"));
  check("model-specific no-pause beats provider-only pause -> async:true", in4.async === true);

  let in5 = { prompt: "x" };
  await fireTool(pi3, in5, ctxFor("http://127.0.0.1:8888/v1", "prov", "other-model"));
  check("provider-only pause still applies to other models -> async:false", in5.async === false);

  // Tie on specificity (both model-level rules): pause wins by design
  writeCfg({ localProviders: ["prov/*"], remoteProviders: ["prov/special"], mode: "auto", detect: true, lanAction: "block", forceRemoteBackground: true, log: false });
  const pi4 = makePi();
  let in6 = { prompt: "x" };
  await fireTool(pi4, in6, ctxFor("http://127.0.0.1:8888/v1", "prov", "special"));
  check("tie between two model-level rules -> pause wins (async:false)", in6.async === false);

  // Tie on provider-only specificity: pause wins by design
  writeCfg({ localProviders: ["tie"], remoteProviders: ["tie"], mode: "auto", detect: true, lanAction: "block", forceRemoteBackground: true, log: false });
  const pi5 = makePi();
  let in7 = { prompt: "x" };
  await fireTool(pi5, in7, ctxFor("http://203.0.113.5:8000/v1", "tie"));
  check("pause/no-pause tie -> pause wins (async:false)", in7.async === false);
}

// ---- 3. global overrides ----------------------------------------------------
{
  writeCfg({ localProviders: [], remoteProviders: ["myserver"], mode: "block", detect: true, lanAction: "background", forceRemoteBackground: true, log: false });
  const pi = makePi();
  let in1 = { prompt: "x" };
  await fireTool(pi, in1, ctxFor("http://203.0.113.5:8000/v1", "myserver")); // nopause rule, but global block
  check("global block overrides no-pause rule -> async:false", in1.async === false);

  writeCfg({ localProviders: [], remoteProviders: [], mode: "background", detect: true, lanAction: "block", forceRemoteBackground: true, log: false });
  const pi2 = makePi();
  let in2 = { prompt: "x" };
  await fireTool(pi2, in2, ctxFor("http://127.0.0.1:8888/v1")); // loopback, but global background
  check("global background overrides local detection -> async:true", in2.async === true);

  writeCfg({ localProviders: [], remoteProviders: [], mode: "auto", detect: false, lanAction: "block", forceRemoteBackground: false, log: false });
  const pi3 = makePi();
  let in3 = { prompt: "x" };
  await fireTool(pi3, in3, ctxFor("http://127.0.0.1:8888/v1")); // detection off, remote-bg off
  check("detection off + remote-bg off -> input untouched", in3.async === undefined);
}

// ---- 4. /subagent-mode command handler --------------------------------------
{
  writeCfg({ localProviders: [], remoteProviders: [], mode: "auto", detect: true, lanAction: "block", forceRemoteBackground: true, log: false });
  const pi = makePi();
  const cmd = pi.commands["subagent-mode"];
  check("command 'subagent-mode' is registered", !!cmd);

  const run = async (args) => {
    const out = [];
    const ctx = {
      ui: { notify: (m) => out.push(m), select: undefined },
      model: { provider: "llamacpp", id: "unsloth/Qwen3.8-27B-GGUF", baseUrl: "http://127.0.0.1:8888/v1" },
    };
    await cmd.handler(args, ctx);
    return out.join("\n");
  };

  const status = await run("status");
  check("'status' reports model + effect", status.includes("llamacpp") && /BLOCK|BACKGROUND|UNTOUCHED/.test(status), status.split("\n")[0]);

  const explain = await run("explain");
  check("'explain' shows endpoint, placement self and own addresses", explain.includes("http://127.0.0.1:8888/v1") && explain.includes("self"), explain.replace(/\n/g, " | ").slice(0, 160));

  await run("pause myserver");
  check("'pause myserver' adds a pause rule", readCfg().localProviders.includes("myserver"));

  await run("nopause otherprov");
  check("'nopause otherprov' adds a no-pause rule", readCfg().remoteProviders.includes("otherprov"));

  const provs = await run("providers");
  check("'providers' lists both rules", provs.includes("myserver") && provs.includes("otherprov"));

  await run("clear myserver");
  check("'clear myserver' removes the pause rule", !readCfg().localProviders.includes("myserver") && readCfg().remoteProviders.includes("otherprov"));

  await run("lan background");
  check("'lan background' persists", readCfg().lanAction === "background");

  await run("detect off");
  check("'detect off' persists", readCfg().detect === false);

  const usage = await run("bogus-subcommand");
  check("unknown subcommand prints usage", usage.startsWith("Usage:"));

  await run("reset");
  check("'reset' restores defaults (auto, detect on)", readCfg().mode === "auto" && readCfg().detect === true);
}

// ---- 5. malformed config file falls back to defaults ------------------------
{
  writeFileSync(CONFIG_PATH, "{not json");
  const pi = makePi(); // must not throw
  let in1 = { prompt: "x" };
  await fireTool(pi, in1, ctxFor("http://127.0.0.1:8888/v1"));
  check("malformed config file -> defaults, loopback still blocks", in1.async === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(fakeHome, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
