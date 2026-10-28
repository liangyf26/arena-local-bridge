#!/usr/bin/env node
// fingerprint-collect.mjs — build the numeric fingerprint bank from Direct mode.
//
// Runs as a standalone process with a fresh browser per invocation. The
// in-service collector had to be abandoned for this shape: the same flow that
// works reliably standalone hangs inside the long-lived service context (the
// exact interaction is still unidentified — the service's page carries the
// model probe hook and shares its context with the converse page). A fresh
// process per run sidesteps all of it, and collection is an occasional batch
// job, not a service.
//
//   node bin/fingerprint-collect.mjs --models "claude-sonnet-5-high,gpt-5.5-instant"
//   node bin/fingerprint-collect.mjs --list            # dump the picker's models
//
// One Direct session per model; each probe variant goes out as a consecutive
// message; replies land in the bank via appendRecord, labelled with the model
// id the Arena UI itself confirmed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { ArenaBrowser } from "../src/arena-login.mjs";
import { requireSecret } from "../src/secret.mjs";
import { probeTurn, variantIds } from "../src/fingerprint/probe-prompts.mjs";
import { appendRecord } from "../src/fingerprint/bank-store.mjs";
import { log } from "../src/util.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
const secret = requireSecret(dotEnv);
const credentials = new CredentialStore({
  filePath: config.credentialsFile,
  secret,
  omniDbPath: config.omniDbPath,
  omniRoot: config.omniRoot,
}).load();
const cred = credentials.primary();
if (!cred) {
  console.error("no usable account — run bin/login.mjs first");
  process.exit(1);
}

const browser = new ArenaBrowser({ omniRoot: config.omniRoot, chromePath: config.chromePath, proxy: config.proxy });
const page = await browser.getPage(cred, "converse");
const readPulse = () =>
  page
    .evaluate(async () => {
      try {
        const r = await fetch("/api/me/pulse", { headers: { Accept: "application/json" } });
        return (await r.json()).pulse ?? null;
      } catch {
        return null;
      }
    })
    .catch(() => null);

const PULSE_FLOOR = Number(process.env.ARENA_FINGERPRINT_PULSE_FLOOR || 30);
const VARIANTS = variantIds();

async function enterDirect() {
  await page.goto("https://arena.ai/agent", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.locator('[contenteditable="true"]').last().waitFor({ state: "visible", timeout: 180_000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /^Agent/i.test((b.innerText || "").trim()));
    if (btn) btn.click();
  });
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] *')].find((e) =>
      /^Direct/i.test((e.innerText || "").trim())
    );
    if (item) item.click();
  });
  await page
    .locator('textarea[placeholder="Ask anything…"]')
    .last()
    .waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForTimeout(4_000);
}

async function pickModel(modelId) {
  await page.evaluate(() => {
    const direct = [...document.querySelectorAll("button")].find((b) => /^Direct$/i.test((b.innerText || "").trim()));
    const bar = direct?.closest('[class*="flex"]')?.parentElement || direct.parentElement;
    const target = [...bar.querySelectorAll("button")].find((b) => {
      const t = (b.innerText || "").trim();
      return t && !/^Direct$/i.test(t) && !/^(发送|Send)/i.test(t);
    });
    if (target) target.click();
  });
  await page.waitForTimeout(2_000);
  await page.evaluate((id) => {
    const search = [...document.querySelectorAll("input")].find((i) => /search|模型/i.test(i.placeholder || ""));
    if (!search) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(search, id);
    search.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, modelId);
  await page.waitForTimeout(2_500);
  const chose = await page.evaluate((id) => {
    const rows = [...document.querySelectorAll('[role="menuitem"], [role="option"], [cmdk-item]')];
    const norm = id.toLowerCase().replace(/[^a-z0-9.]/g, "");
    const item =
      rows.find((e) => (e.innerText || "").trim().toLowerCase().replace(/[^a-z0-9.]/g, "") === norm) ||
      rows.find((e) => (e.innerText || "").trim().toLowerCase().includes(norm));
    if (item) {
      item.click();
      return (item.innerText || "").trim().slice(0, 60);
    }
    return null;
  }, modelId);
  if (!chose) throw new Error(`model "${modelId}" not found in the Direct picker`);
  // picking re-renders the conversation area; the composer remounts
  await page.locator('textarea[placeholder="Ask anything…"]').last().waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForTimeout(4_000);
  return chose;
}

async function sendProbe(variant) {
  const prompt = probeTurn(variant);
  const clause = prompt.split("\n")[0].slice(0, 40);
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = page.locator('textarea[placeholder="Ask anything…"]').last();
    await box.waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
    let enabled = false;
    for (let i = 0; i < 20 && !enabled; i++) {
      // re-fill every iteration: a fill landing while React is still
      // hydrating sets the DOM value without registering it in state
      await box.fill(prompt).catch(() => undefined);
      await page.waitForTimeout(3_000);
      enabled = await page
        .evaluate(() => [...document.querySelectorAll('button[data-perf-target="send"]')].some((b) => !b.disabled))
        .catch(() => false);
    }
    if (!enabled) throw new Error("send button stayed disabled (composer not ready)");
    const clicked = await page
      .evaluate(() => {
        const b = [...document.querySelectorAll('button[data-perf-target="send"]')].find((x) => !x.disabled);
        if (b) {
          b.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (!clicked) await box.press("Enter").catch(() => undefined);

    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(3_000);
      const s = await page
        .evaluate(
          ({ clause }) => {
            const text = document.body?.innerText || "";
            const echoAt = text.lastIndexOf(clause);
            const after = echoAt >= 0 ? text.slice(echoAt + clause.length) : "";
            const boxEl = [...document.querySelectorAll('textarea[placeholder="Ask anything…"]')].pop();
            const live = boxEl ? !boxEl.value.trim() : false;
            const errorish = /prompt failed|rate limit|出现错误|出错了/i.test(text.slice(-500));
            return { after, live, errorish };
          },
          { clause }
        )
        .catch(() => ({ after: "", live: false, errorish: false }));
      if (s.errorish) throw new Error(`arena rejected the probe: ${s.after.slice(-100).trim()}`);
      const ints = s.after.match(/\b\d{1,3}\b/g) || [];
      if (s.live && ints.length >= 30) return ints.join(" ");
    }
    log.warn("fingerprint-collect", "probe reply not captured; retrying", { variant, attempt: attempt + 1 });
  }
  throw new Error(`probe ${variant} produced no reply after retries`);
}

async function backToAgent() {
  await page
    .evaluate(() => {
      const direct = [...document.querySelectorAll("button")].find((b) => /^Direct$/i.test((b.innerText || "").trim()));
      if (!direct) return;
      const bar = direct.closest('[class*="flex"]')?.parentElement || direct.parentElement;
      const target = [...bar.querySelectorAll("button")].find((b) => /^Direct$/i.test((b.innerText || "").trim()));
      if (target) target.click();
    })
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
  await page
    .evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] *')].find((e) =>
        /^Agent Mode/i.test((e.innerText || "").trim())
      );
      if (item) item.click();
    })
    .catch(() => undefined);
  await page.locator('[contenteditable="true"]').last().waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
}

const listOnly = args.includes("--list");
await enterDirect();
if (listOnly) {
  // dump every model the picker offers, for matching external name lists
  await page.evaluate(() => {
    const direct = [...document.querySelectorAll("button")].find((b) => /^Direct$/i.test((b.innerText || "").trim()));
    const bar = direct?.closest('[class*="flex"]')?.parentElement || direct.parentElement;
    const target = [...bar.querySelectorAll("button")].find((b) => {
      const t = (b.innerText || "").trim();
      return t && !/^Direct$/i.test(t) && !/^(发送|Send)/i.test(t);
    });
    if (target) target.click();
  });
  await page.waitForTimeout(2_500);
  const models = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="menuitem"], [role="option"], [cmdk-item]')];
    return [...new Set(rows.map((e) => (e.innerText || "").trim().split("\n")[0]).filter(Boolean))];
  });
  console.log(JSON.stringify(models, null, 1));
  await browser.close().catch(() => {});
  process.exit(0);
}

const models = flag("--models")
  ? String(flag("--models"))
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
  : [];
if (!models.length) {
  console.error("usage: node bin/fingerprint-collect.mjs --models \"id1,id2\" | --list");
  process.exit(2);
}

let pulse = await readPulse();
console.log(JSON.stringify({ event: "start", models: models.length, pulse }));
const summary = [];
for (const modelId of models) {
  if (pulse !== null && pulse < PULSE_FLOOR) {
    console.log(JSON.stringify({ event: "pulse-floor", pulse, floor: PULSE_FLOOR }));
    break;
  }
  const started = Date.now();
  let stored = 0;
  try {
    await enterDirect();
    await pickModel(modelId);
    for (const variant of VARIANTS) {
      const reply = await sendProbe(variant);
      appendRecord(dataDir, { text: reply, model: modelId, variant, condition: variant });
      stored += 1;
      await page.waitForTimeout(3_000);
    }
    console.log(JSON.stringify({ event: "model-ok", modelId, stored, ms: Date.now() - started }));
  } catch (error) {
    console.log(JSON.stringify({ event: "model-failed", modelId, stored, error: String(error?.message || error).slice(0, 200) }));
    summary.push({ modelId, ok: false, stored, error: String(error?.message || error).slice(0, 120) });
    await backToAgent().catch(() => undefined);
    continue;
  }
  summary.push({ modelId, ok: true, stored });
  pulse = await readPulse();
  await backToAgent().catch(() => undefined);
  await page.waitForTimeout(10_000);
}
console.log(JSON.stringify({ event: "done", summary, pulse: await readPulse() }));
await browser.close().catch(() => {});
process.exit(0);
