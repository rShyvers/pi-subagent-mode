/**
 * pi-subagent-mode
 *
 * Partner extension for pi-subagents.
 * Decides, per call and per active model, whether the `subagent` tool runs in
 * the foreground (main model pauses until children finish) or the background.
 *
 * How the mode is decided (first match wins):
 *   1. Global override        /subagent-mode block | background
 *   2. Provider/model rules   your own lists, matched on provider id or provider/model id
 *                             (most specific wins; wildcards allowed, e.g. "myserver/*"):
 *                               pause list     /subagent-mode pause <rule>    -> block
 *                               no-pause list  /subagent-mode nopause <rule>  -> background
 *                             Use the pause list for servers that are reachable remotely
 *                             (LAN, VPN, internet) but can only serve one model/request at
 *                             a time. These rules always beat endpoint detection.
 *   3. Endpoint detection     the model's baseUrl host is resolved to IPs and compared
 *                             with this machine's own addresses and private ranges:
 *                               - loopback / one of this machine's own IPs -> "self"   -> block
 *                               - private LAN (10.x, 172.16-31.x, 192.168.x, 100.64/10,
 *                                 link-local, IPv6 ULA)                    -> "lan"    -> configurable
 *                               - public address                          -> "remote" -> background
 *   4. Fallback               could not tell -> treated as remote
 *
 * Commands (changes apply immediately and persist to ~/.pi/agent/subagent-mode.json):
 *   /subagent-mode                   status (menu if the UI supports it)
 *   /subagent-mode explain           show endpoint, resolved IPs, placement and why
 *   /subagent-mode auto|block|background
 *   /subagent-mode pause [rule]      always pause for a provider or model  (alias: local)
 *   /subagent-mode nopause [rule]    never pause for it                    (alias: remote)
 *       rule = provider id | provider/model id | wildcard | "model" (= current provider/model)
 *              default (no rule) = current model's provider
 *   /subagent-mode clear [rule]      remove matching rules, back to detection
 *   /subagent-mode providers         list pause / no-pause rules
 *   /subagent-mode models [status|one|all|cap N]
 *                                    talk to a model-gate (bin/model-gate.mjs) sitting in front
 *                                    of the current model's server: show its state, or choose
 *                                    whether different models may run at once ("all") or only
 *                                    one model at a time in groups ("one"). Needs the provider's
 *                                    baseUrl to point at the gate. Set PI_GATE_TOKEN if the gate
 *                                    was started with --admin-token.
 *   /subagent-mode detect on|off     endpoint detection on/off
 *   /subagent-mode lan block|background   what to do for private-network endpoints
 *   /subagent-mode remote-bg on|off  explicitly set async:true for remote calls
 *   /subagent-mode log on|off        decision logging to ~/.pi/agent/subagent-hook.log
 *   /subagent-mode reset
 *
 * First-run seeds: PI_LOCAL_PROVIDERS="unsloth,ollama"  PI_SYNC_HOOK_LOG=0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as dns } from "node:dns";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types + config persistence
// ---------------------------------------------------------------------------
type Mode = "auto" | "block" | "background";
type Placement = "self" | "lan" | "remote" | "unknown";
// block            -> async:false (pause)
// force-background -> async:true  (always)
// remote-default   -> async:true only if the call did not specify it (and remote-bg is on)
type Action = "block" | "force-background" | "remote-default";

interface Config {
  localProviders: string[]; // "pause" rules (field name kept for saved-config compatibility)
  remoteProviders: string[]; // "no-pause" rules (field name kept for saved-config compatibility)
  mode: Mode;
  detect: boolean;
  lanAction: "block" | "background";
  forceRemoteBackground: boolean;
  log: boolean;
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "subagent-mode.json");
const LOG_PATH = join(AGENT_DIR, "subagent-hook.log");

const splitList = (s: string | undefined): string[] =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

function defaults(): Config {
  return {
    localProviders: splitList(process.env.PI_LOCAL_PROVIDERS),
    remoteProviders: [],
    mode: "auto",
    detect: true,
    lanAction: "block",
    forceRemoteBackground: true,
    log: process.env.PI_SYNC_HOOK_LOG !== "0",
  };
}

const strList = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) ? v.map((s) => String(s).toLowerCase()) : fallback;

function load(): Config {
  const base = defaults();
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      localProviders: strList(raw.localProviders, base.localProviders),
      remoteProviders: strList(raw.remoteProviders, base.remoteProviders),
      mode: ["auto", "block", "background"].includes(raw.mode) ? raw.mode : base.mode,
      detect: typeof raw.detect === "boolean" ? raw.detect : base.detect,
      lanAction: raw.lanAction === "background" ? "background" : raw.lanAction === "block" ? "block" : base.lanAction,
      forceRemoteBackground:
        typeof raw.forceRemoteBackground === "boolean" ? raw.forceRemoteBackground : base.forceRemoteBackground,
      log: typeof raw.log === "boolean" ? raw.log : base.log,
    };
  } catch {
    return base; // missing or malformed file -> defaults
  }
}

function save(cfg: Config): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {
    // Never break the agent over a failed save; in-memory config still applies.
  }
}

function writeLog(cfg: Config, entry: Record<string, unknown>): void {
  if (!cfg.log) return;
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Logging must never break the agent.
  }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------
type IpClass = "loopback" | "private" | "public";

function v4ToInt(ip: string): number | undefined {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = v4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (b & mask) >>> 0;
}

function normalizeIp(ip: string): string {
  let s = ip.toLowerCase().split("%")[0]; // strip IPv6 zone id
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped IPv6
  if (mapped) s = mapped[1];
  return s;
}

function classifyIp(raw: string): IpClass {
  const ip = normalizeIp(raw);
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    if (n === undefined) return "public";
    if (inCidr4(n, "127.0.0.0", 8) || n === 0) return "loopback";
    if (
      inCidr4(n, "10.0.0.0", 8) ||
      inCidr4(n, "172.16.0.0", 12) ||
      inCidr4(n, "192.168.0.0", 16) ||
      inCidr4(n, "169.254.0.0", 16) || // link-local
      inCidr4(n, "100.64.0.0", 10) // CGNAT, also used by Tailscale
    )
      return "private";
    return "public";
  }
  if (isIP(ip) === 6) {
    if (ip === "::1" || ip === "::") return "loopback";
    if (/^f[cd]/.test(ip)) return "private"; // fc00::/7 unique local
    if (/^fe[89ab]/.test(ip)) return "private"; // fe80::/10 link-local
    return "public";
  }
  return "public";
}

/** All addresses assigned to this machine's interfaces (Wi-Fi, Ethernet, VPN, docker, ...). */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  try {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) out.add(normalizeIp(a.address));
    }
  } catch {
    // ignore
  }
  return out;
}

// ---------------------------------------------------------------------------
// Endpoint resolution (cached, time-limited)
// ---------------------------------------------------------------------------
const DNS_TTL_MS = 60_000;
const DNS_TIMEOUT_MS = 750;
const dnsCache = new Map<string, { ips: string[]; exp: number }>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

async function resolveHost(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  if (host === "localhost") return ["127.0.0.1", "::1"];
  const hit = dnsCache.get(host);
  if (hit && hit.exp > Date.now()) return hit.ips;
  try {
    const res = await withTimeout(dns.lookup(host, { all: true }), DNS_TIMEOUT_MS);
    const ips = (res ?? []).map((r) => r.address);
    dnsCache.set(host, { ips, exp: Date.now() + DNS_TTL_MS });
    return ips;
  } catch {
    return [];
  }
}

async function classifyEndpoint(
  endpoint: string,
): Promise<{ placement: Placement; ips: string[]; host?: string }> {
  let host: string;
  try {
    host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return { placement: "unknown", ips: [] };
  }
  const ips = await resolveHost(host);
  if (ips.length === 0) return { placement: "unknown", ips, host };

  const own = ownAddresses();
  const classes = ips.map((ip): Placement => {
    const c = classifyIp(ip);
    if (c === "loopback" || own.has(normalizeIp(ip))) return "self";
    return c === "private" ? "lan" : "remote";
  });
  // Conservative: if anything resolves to a public address, call it remote.
  const placement: Placement = classes.includes("remote") ? "remote" : classes.includes("lan") ? "lan" : "self";
  return { placement, ips, host };
}

/** Find the model's endpoint URL. Shape is not guaranteed, so try a few places. */
function endpointOf(ctx: any): string | undefined {
  const m = ctx?.model;
  const direct = m?.baseUrl ?? m?.baseURL;
  if (typeof direct === "string" && direct) return direct;
  try {
    const b = ctx?.modelRegistry?.getProvider?.(m?.provider)?.baseUrl;
    if (typeof b === "string" && b) return b;
  } catch {
    // ignore
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Optional: model-gate admin client (see bin/model-gate.mjs)
// ---------------------------------------------------------------------------
async function gateRequest(ctx: any, body?: Record<string, unknown>): Promise<any> {
  const endpoint = endpointOf(ctx);
  if (!endpoint) throw new Error("could not read the current model's endpoint");
  const origin = new URL(endpoint).origin;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.PI_GATE_TOKEN) headers["x-gate-token"] = process.env.PI_GATE_TOKEN;
  const res = await fetch(`${origin}/__gate/${body ? "mode" : "status"}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2000),
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok || !json || typeof json.mode !== "string")
    throw new Error(`no model-gate answered at ${origin} (HTTP ${res.status}). Is the provider's baseUrl pointing at the gate?`);
  return json;
}

function gateText(g: any): string {
  const active = Object.entries(g.active ?? {}).map(([m, n]) => `${m} x${n}`).join(", ") || "idle";
  const queued = (g.queued ?? []).length ? (g.queued as string[]).join(", ") : "none";
  return `Gate: ${g.mode === "one-model" ? "ONE MODEL AT A TIME (grouped)" : "ALL MODELS MAY RUN TOGETHER"}\nActive: ${active} | queued: ${queued}\nper-model cap: ${g.perModelCap || "unlimited"} | max concurrent (all mode): ${g.maxConcurrent || "unlimited"}\nUpstream: ${g.upstream}`;
}

// ---------------------------------------------------------------------------
// Provider / model rules
// ---------------------------------------------------------------------------
function globToRe(g: string): RegExp {
  const body = g
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + "$", "i");
}

/**
 * Best matching rule. Entries without "/" match the provider id (specificity 1);
 * entries with "/" match "provider/modelId" (specificity 2). Wildcards (*) allowed.
 */
function bestMatch(
  list: string[],
  provider?: string,
  modelId?: string,
): { entry: string; score: number } | undefined {
  if (!provider) return undefined;
  const p = provider.toLowerCase();
  const full = `${p}/${(modelId ?? "").toLowerCase()}`;
  let best: { entry: string; score: number } | undefined;
  for (const entry of list) {
    const isModelRule = entry.includes("/");
    if (!globToRe(entry).test(isModelRule ? full : p)) continue;
    const score = isModelRule ? 2 : 1;
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------
interface Decision {
  action: Action;
  reason: string;
  provider?: string;
  modelId?: string;
  endpoint?: string;
  placement?: Placement;
  ips?: string[];
}

async function decide(cfg: Config, ctx: any): Promise<Decision> {
  const provider: string | undefined = ctx?.model?.provider;
  const modelId: string | undefined = ctx?.model?.id;
  const base = { provider, modelId };

  if (cfg.mode === "block") return { ...base, action: "block", reason: "global override: block" };
  if (cfg.mode === "background")
    return { ...base, action: "force-background", reason: "global override: background" };
  // Your own provider/model rules beat endpoint detection. More specific rule wins;
  // on an exact tie the pause rule wins (safer for single-slot servers).
  const pauseRule = bestMatch(cfg.localProviders, provider, modelId);
  const noPauseRule = bestMatch(cfg.remoteProviders, provider, modelId);
  if (pauseRule && (!noPauseRule || pauseRule.score >= noPauseRule.score))
    return { ...base, action: "block", reason: `pause rule "${pauseRule.entry}" (beats detection)` };
  if (noPauseRule)
    return { ...base, action: "remote-default", reason: `no-pause rule "${noPauseRule.entry}" (beats detection)` };

  let endpoint: string | undefined;
  let placement: Placement | undefined;
  let ips: string[] | undefined;

  if (cfg.detect) {
    endpoint = endpointOf(ctx);
    if (endpoint) {
      const r = await classifyEndpoint(endpoint);
      placement = r.placement;
      ips = r.ips;
      const ex = { ...base, endpoint, placement, ips };
      if (placement === "self") return { ...ex, action: "block", reason: "endpoint is on this machine" };
      if (placement === "lan")
        return {
          ...ex,
          action: cfg.lanAction === "block" ? "block" : "remote-default",
          reason: `endpoint is on a private network (lan -> ${cfg.lanAction})`,
        };
      if (placement === "remote")
        return { ...ex, action: "remote-default", reason: "endpoint is on a public address" };
    }
  }

  return {
    ...base,
    endpoint,
    placement,
    ips,
    action: "remote-default",
    reason: !cfg.detect
      ? "detection off and no forced provider; defaulting to remote"
      : !endpoint
        ? "could not read the model's endpoint; defaulting to remote"
        : "could not resolve the endpoint host; defaulting to remote",
  };
}

const actionLabel = (a: Action, cfg: Config): string =>
  a === "block"
    ? "BLOCK (async:false, main model pauses)"
    : a === "force-background"
      ? "BACKGROUND (async:true, forced)"
      : cfg.forceRemoteBackground
        ? "BACKGROUND (async:true when unspecified)"
        : "UNTOUCHED (package defaults)";

async function statusText(cfg: Config, ctx: any): Promise<string> {
  const d = await decide(cfg, ctx);
  return [
    `Model: ${d.provider ?? "unknown"}/${d.modelId ?? "unknown"}`,
    `Effect: ${actionLabel(d.action, cfg)}`,
    `Why: ${d.reason}`,
    `Mode: ${cfg.mode} | detect: ${cfg.detect ? "on" : "off"} | lan: ${cfg.lanAction} | remote-bg: ${cfg.forceRemoteBackground ? "on" : "off"} | log: ${cfg.log ? "on" : "off"}`,
  ].join("\n");
}

async function explainText(cfg: Config, ctx: any): Promise<string> {
  const d = await decide(cfg, ctx);
  const own = [...ownAddresses()].filter((a) => classifyIp(a) !== "loopback");
  return [
    `Model: ${d.provider ?? "unknown"}/${d.modelId ?? "unknown"}`,
    `Endpoint: ${d.endpoint ?? endpointOf(ctx) ?? "(not found)"}`,
    `Resolved: ${d.ips?.join(", ") || "(none)"}`,
    `Placement: ${d.placement ?? "(not evaluated)"}`,
    `Effect: ${actionLabel(d.action, cfg)}`,
    `Why: ${d.reason}`,
    `This machine's addresses: ${own.slice(0, 6).join(", ") || "(none found)"}${own.length > 6 ? ", ..." : ""}`,
    `Pause rules: ${cfg.localProviders.join(", ") || "-"} | no-pause rules: ${cfg.remoteProviders.join(", ") || "-"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  // Live config: the hook reads it on every call, so edits apply instantly.
  let cfg: Config = load();

  // ---- The hook -----------------------------------------------------------
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "subagent") return;

    const input = event.input as Record<string, any>;

    // Management / status / wait calls: never touch.
    if (input.action) {
      writeLog(cfg, { decision: "skip-action", action: input.action, provider: ctx?.model?.provider });
      return;
    }

    let d: Decision;
    try {
      d = await decide(cfg, ctx);
    } catch {
      d = { action: "remote-default", reason: "decision error; defaulting to remote" };
    }

    const asyncBefore = input.async;
    if (d.action === "block") input.async = false;
    else if (d.action === "force-background") input.async = true;
    else if (cfg.forceRemoteBackground && input.async === undefined) input.async = true;

    writeLog(cfg, {
      action: d.action,
      reason: d.reason,
      provider: d.provider,
      modelId: d.modelId,
      endpoint: d.endpoint,
      placement: d.placement,
      ips: d.ips,
      asyncBefore,
      asyncAfter: input.async,
      hasWorkflowScript: typeof input.workflowScript === "string",
    });
  });

  // ---- The in-editor command ---------------------------------------------
  pi.registerCommand("subagent-mode", {
    description: "View or change how subagent calls pause/background, per model (live)",
    handler: async (args: any, ctx: any) => {
      const notify = (msg: string) => ctx.ui.notify(msg, "info");
      const raw = Array.isArray(args) ? args.join(" ") : String(args ?? "");
      const tokens = raw.trim().split(/\s+/).filter(Boolean);
      let cmd = tokens[0]?.toLowerCase();
      const arg = tokens[1]?.toLowerCase();
      const currentProvider: string | undefined = ctx?.model?.provider?.toLowerCase();

      // No args: try an interactive menu, otherwise just show status.
      if (!cmd) {
        if (typeof ctx?.ui?.select === "function") {
          try {
            const choices = [
              "status",
              "explain",
              "auto (detect per model)",
              "block (all models pause)",
              "background (no model pauses)",
              "always pause for current provider",
              "never pause for current provider",
              "clear rules for current provider",
              "toggle logging",
            ];
            const picked: string | undefined = await ctx.ui.select(
              `Subagent mode\n${await statusText(cfg, ctx)}`,
              choices,
            );
            if (!picked) return;
            cmd = picked.split(" ")[0].toLowerCase();
            if (picked.startsWith("always pause")) cmd = "pause";
            else if (picked.startsWith("never pause")) cmd = "nopause";
            else if (picked.startsWith("clear rules")) cmd = "clear";
            else if (picked.startsWith("toggle logging")) {
              cmd = "log";
              tokens[1] = cfg.log ? "off" : "on";
            }
          } catch {
            notify(await statusText(cfg, ctx));
            return;
          }
        } else {
          notify(await statusText(cfg, ctx));
          return;
        }
      }

      const value = (tokens[1] ?? "").toLowerCase();
      const currentModelId: string | undefined = ctx?.model?.id?.toLowerCase();
      // rule argument: explicit rule, "model" = current provider/model, default = current provider
      const needRule = (verb: string): string | undefined => {
        const r = arg === "model" ? (currentProvider && currentModelId ? `${currentProvider}/${currentModelId}` : undefined) : (arg ?? currentProvider);
        if (!r) notify(`No rule given and current model has none. Use: /subagent-mode ${verb} <provider | provider/model | wildcard>`);
        return r;
      };

      switch (cmd) {
        case "status":
          notify(await statusText(cfg, ctx));
          return;

        case "explain":
          notify(await explainText(cfg, ctx));
          return;

        case "auto":
        case "block":
        case "background":
          cfg.mode = cmd as Mode;
          save(cfg);
          notify(`Mode set to ${cmd}.\n${await statusText(cfg, ctx)}`);
          return;

        case "pause":
        case "local": {
          const r = needRule("pause");
          if (!r) return;
          cfg.remoteProviders = cfg.remoteProviders.filter((x) => x !== r);
          if (!cfg.localProviders.includes(r)) cfg.localProviders.push(r);
          save(cfg);
          notify(`Rule added: always PAUSE for "${r}" (beats detection).\n${await statusText(cfg, ctx)}`);
          return;
        }

        case "nopause":
        case "remote": {
          const r = needRule("nopause");
          if (!r) return;
          cfg.localProviders = cfg.localProviders.filter((x) => x !== r);
          if (!cfg.remoteProviders.includes(r)) cfg.remoteProviders.push(r);
          save(cfg);
          notify(`Rule added: never pause for "${r}" (beats detection).\n${await statusText(cfg, ctx)}`);
          return;
        }

        case "clear": {
          // With no argument, clear every rule that currently matches the active model.
          const targets: string[] = [];
          if (arg) {
            targets.push(arg === "model" && currentProvider && currentModelId ? `${currentProvider}/${currentModelId}` : arg);
          } else {
            const pm = bestMatch(cfg.localProviders, ctx?.model?.provider, ctx?.model?.id);
            const rm = bestMatch(cfg.remoteProviders, ctx?.model?.provider, ctx?.model?.id);
            if (pm) targets.push(pm.entry);
            if (rm) targets.push(rm.entry);
          }
          if (targets.length === 0) return notify("No matching rule to clear.");
          cfg.localProviders = cfg.localProviders.filter((x) => !targets.includes(x));
          cfg.remoteProviders = cfg.remoteProviders.filter((x) => !targets.includes(x));
          save(cfg);
          notify(`Cleared: ${targets.join(", ")}; using detection.\n${await statusText(cfg, ctx)}`);
          return;
        }

        case "models": {
          try {
            if (!value || value === "status") return notify(gateText(await gateRequest(ctx)));
            if (value === "one" || value === "one-model")
              return notify(gateText(await gateRequest(ctx, { mode: "one-model" })));
            if (value === "all") return notify(gateText(await gateRequest(ctx, { mode: "all" })));
            if (value === "cap") {
              const n = Number(tokens[2]);
              if (!Number.isInteger(n) || n < 0) return notify("Usage: /subagent-mode models cap <0|1|2|...> (0 = unlimited)");
              return notify(gateText(await gateRequest(ctx, { perModelCap: n })));
            }
            return notify("Usage: /subagent-mode models [status|one|all|cap N]");
          } catch (e: any) {
            return notify(`models: ${e?.message ?? e}`);
          }
        }

        case "providers":
          notify(
            `Pause rules: ${cfg.localProviders.join(", ") || "(none)"}\nNo-pause rules: ${cfg.remoteProviders.join(", ") || "(none)"}`,
          );
          return;

        case "detect":
          if (value !== "on" && value !== "off") return notify("Usage: /subagent-mode detect on|off");
          cfg.detect = value === "on";
          save(cfg);
          notify(`Detection ${value}.\n${await statusText(cfg, ctx)}`);
          return;

        case "lan":
          if (value !== "block" && value !== "background")
            return notify("Usage: /subagent-mode lan block|background");
          cfg.lanAction = value;
          save(cfg);
          notify(`Private-network endpoints will ${value}.\n${await statusText(cfg, ctx)}`);
          return;

        case "remote-bg":
          if (value !== "on" && value !== "off") return notify("Usage: /subagent-mode remote-bg on|off");
          cfg.forceRemoteBackground = value === "on";
          save(cfg);
          notify(`remote-bg ${value}.\n${await statusText(cfg, ctx)}`);
          return;

        case "log":
          if (value !== "on" && value !== "off") return notify("Usage: /subagent-mode log on|off");
          cfg.log = value === "on";
          save(cfg);
          notify(`Logging ${value}. File: ${LOG_PATH}`);
          return;

        case "reset":
          cfg = defaults();
          save(cfg);
          notify(`Reset to defaults.\n${await statusText(cfg, ctx)}`);
          return;

        default:
          notify(
            "Usage: /subagent-mode [status|explain|auto|block|background|pause [rule]|nopause [rule]|clear [rule]|providers|models [status|one|all|cap N]|detect on|off|lan block|background|remote-bg on|off|log on|off|reset]",
          );
      }
    },
  });
}
