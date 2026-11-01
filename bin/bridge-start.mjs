#!/usr/bin/env node
/**
 * bin/bridge-start.mjs — start the local bridge detached and wait for ready.
 * Replaces fragile bat quoting: node spawns node, polls /health, prints state.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
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
const base = `http://127.0.0.1:${port}`;
const get = async (p, ms = 5000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(`${base}${p}`, { signal: c.signal });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

// 1. 代理前置检查
const socksMatch = (dotEnv.ARENA_AGENT_PROXY || "").match(/127\.0\.0\.1:(\d+)/);
const socksPort = socksMatch ? socksMatch[1] : "10808";
let proxyIp = "";
try {
  proxyIp = execSync(`curl -s --max-time 8 --socks5-hostname 127.0.0.1:${socksPort} https://api.ipify.org`, { timeout: 12_000 }).toString().trim();
} catch {}
if (!proxyIp) {
  console.error(`[arena-bridge] v2rayN proxy not reachable on 127.0.0.1:${socksPort} — start v2rayN first.`);
  process.exit(1);
}
console.log(`[arena-bridge] proxy exit: ${proxyIp}`);

// 2. 已在运行则退出
const existing = await get("/health", 3000);
if (existing) {
  console.log(`[arena-bridge] already running on ${base}`);
  process.exit(existing.body.includes('"ready":true') ? 0 : 1);
}

// 3. 分离启动（关掉本进程也不影响桥）
const logPath = path.join(dataDir, "bridge.log");
const out = fs.openSync(logPath, "a");
const child = spawn(process.execPath, [path.join(repoRoot, "src", "index.mjs")], {
  cwd: repoRoot,
  detached: true,
  stdio: ["ignore", out, out],
  env: { ...process.env },
});
child.unref();
console.log(`[arena-bridge] spawning pid=${child.pid}, log=${logPath}`);

// 4. 轮询就绪（登录验证 + 浏览器启动，最多 2 分钟）
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const health = await get("/health", 4000);
  if (health && health.body.includes('"ready":true')) {
    console.log(`[arena-bridge] ready on ${base} (OpenAI-compatible: /v1)`);
    process.exit(0);
  }
}
console.error(`[arena-bridge] not ready after 2 min — check ${logPath}`);
process.exit(1);
