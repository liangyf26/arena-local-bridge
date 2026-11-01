#!/usr/bin/env node
/**
 * bin/bridge-status.mjs — one-glance health report for the local bridge:
 * proxy exit, service health, session slots (/v1/models), telemetry volume.
 * Exits 0 when the bridge is ready, 1 otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
const dotEnv = fs.existsSync(path.join(dataDir, ".env"))
  ? Object.fromEntries(
      fs
        .readFileSync(path.join(dataDir, ".env"), "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i), l.slice(i + 1)];
        })
    )
  : {};
const port = dotEnv.PORT || "20140";
const host = dotEnv.HOST || "127.0.0.1";
const base = `http://${host}:${port}`;
const bridgeKey = dotEnv.ARENA_AGENT_BRIDGE_KEY || "";
const get = async (p, ms = 6000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(`${base}${p}`, {
      signal: c.signal,
      headers: bridgeKey ? { authorization: `Bearer ${bridgeKey}` } : {},
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

const socksMatch = (dotEnv.ARENA_AGENT_PROXY || "").match(/127\.0\.0\.1:(\d+)/);
const socksPort = socksMatch ? socksMatch[1] : "10808";

// 1. 代理出口（arena.ai 必须走代理）
let proxy = "proxy DOWN — start v2rayN";
try {
  const { execSync } = await import("node:child_process");
  proxy = execSync(`curl -s --max-time 8 --socks5-hostname 127.0.0.1:${socksPort} https://api.ipify.org`, { timeout: 12_000 })
    .toString()
    .trim();
} catch {}
console.log(`proxy exit   : ${proxy}`);

// 2. 服务健康
const health = await get("/health");
if (!health) {
  console.log(`service      : DOWN on ${base} — run start-bridge.bat`);
  process.exit(1);
}
let h = {};
try {
  h = JSON.parse(health.body);
} catch {}
console.log(`service      : ${h.ok ? "UP" : "degraded"} ready=${h.ready} uptime=${h.uptimeSeconds}s accounts=${h.activeArenaAccounts}`);

// 3. 会话槽位
const models = await get("/v1/models");
if (models) {
  try {
    const list = JSON.parse(models.body).data || [];
    console.log(`slots        : ${list.length}`);
    for (const m of list) console.log(`  - ${m.id}  ${m.name || ""}`);
  } catch {}
}

// 4. 遥测
const tasksPath = path.join(dataDir, "telemetry-tasks.jsonl");
if (fs.existsSync(tasksPath)) {
  const lines = fs.readFileSync(tasksPath, "utf8").trim().split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  console.log(`telemetry    : ${lines.length} task record(s), last ${last.at} (${last.durationSec}s, ${last.outputTokens} tok)`);
} else {
  console.log("telemetry    : 0 task records yet");
}

process.exit(h.ready ? 0 : 1);
