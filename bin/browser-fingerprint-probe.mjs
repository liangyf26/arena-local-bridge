#!/usr/bin/env node
/**
 * bin/browser-fingerprint-probe.mjs — measure the detection surface of a
 * browser environment, so fixes target measured differences instead of guesses.
 *
 * Runs the classic bot-detection checks against arena.ai and prints one JSON
 * object. Run it in every environment you can (VPS xvfb Chrome, local headed
 * Chrome, the user's real browser) and diff the outputs — each differing field
 * is a signal reCAPTCHA may be reading.
 *
 * Usage:
 *   node bin/browser-fingerprint-probe.mjs                     # bridge config launch
 *   node bin/browser-fingerprint-probe.mjs --cdp http://127.0.0.1:9222   # attach
 */
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { ArenaBrowser } from "../src/arena-login.mjs";

const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });

const cdpUrl = process.argv.includes("--cdp") ? process.argv[process.argv.indexOf("--cdp") + 1] : "";

let browser;
let context;
if (cdpUrl) {
  const pw = (await import("playwright")).chromium;
  browser = await pw.connectOverCDP(cdpUrl, { timeout: 30_000 });
  // Attach mode: use the browser's REAL default context — its fingerprint,
  // cookies and history are the whole point. A fresh context would be a
  // synthetic profile with the same leaks we are trying to escape.
  context = browser.contexts()[0] || (await browser.newContext());
} else {
  // Measure the REAL service-shaped context: getPage is where the context
  // init scripts (webdriver/nav/webgl spoofs) actually live. A raw
  // browser.newContext() bypasses all of it and measures nothing useful.
  const { CredentialStore } = await import("../src/credentials.mjs");
  const { requireSecret } = await import("../src/secret.mjs");
  const secret = requireSecret(dotEnv);
  const credentials = new CredentialStore({ filePath: config.credentialsFile, secret, omniDbPath: config.omniDbPath, omniRoot: config.omniRoot }).load();
  const arena = new ArenaBrowser({ omniRoot: config.omniRoot, chromePath: config.chromePath, proxy: config.proxy });
  browser = { close: () => arena.close().catch(() => undefined) };
  context = { newPage: () => arena.getPage(credentials.primary(), "harvest") };
}

const page = await context.newPage();
await page.goto("https://arena.ai/agent", { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => undefined);
await page.waitForTimeout(6_000);

const report = await page.evaluate(async () => {
  const gl = document.createElement("canvas").getContext("webgl");
  const debugInfo = gl && gl.getExtension("WEBGL_debug_renderer_info");
  const toStringNative = (() => {
    // The classic integrity tell: a wrapped function leaks its own source.
    const s = Function.prototype.toString.call(window.fetch);
    return { fetchIsNative: /\{\s*\[native code\]\s*\}/.test(s), fetchSourceHead: s.slice(0, 80) };
  })();
  const notificationMismatch = await (async () => {
    // Headless/automation tell: Notification.permission says "prompt" but the
    // permission query resolves "denied" — impossible in a real user profile.
    try {
      const state = (await navigator.permissions.query({ name: "notifications" })).state;
      return { query: state, permission: Notification.permission, mismatch: state !== Notification.permission };
    } catch (error) {
      return { error: String(error).slice(0, 60) };
    }
  })();
  let audio = null;
  try {
    const ctx = new AudioContext();
    audio = { sampleRate: ctx.sampleRate, state: ctx.state };
    ctx.close();
  } catch {
    audio = { error: "no AudioContext" };
  }
  return {
    navigator: {
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      languages: navigator.languages,
      plugins: navigator.plugins.length,
    },
    webgl: debugInfo
      ? { vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) }
      : { error: "no webgl" },
    chrome: { hasChromeObject: Boolean(window.chrome), hasRuntime: Boolean(window.chrome?.runtime) },
    functionIntegrity: toStringNative,
    notificationMismatch,
    audio,
    screen: { w: screen.width, h: screen.height, colorDepth: screen.colorDepth },
    cdcMarkers: Object.keys(window).filter((k) => /cdc_|__driver|__selenium|__webdriver|__fxdriver|\$wdc_/i.test(k)),
    url: location.href,
  };
});

console.log(JSON.stringify({ env: cdpUrl ? `cdp:${cdpUrl}` : `launch:${os.hostname()}`, ...report }, null, 1));
await browser.close().catch(() => undefined);
process.exit(0);
