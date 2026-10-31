#!/usr/bin/env node
/**
 * bin/telemetry-baseline.mjs — ingest the agent-leaderboard telemetry prior,
 * and label measured turns with it.
 *
 * The baseline is the leaderboard's published per-model statistics (Time/Task,
 * Output Tokens/Task, bash-failure rate, tool-hallucination rate, ...). It is
 * what lets a passively measured turn vote on which of the ~55 candidate
 * classes answered, without spending a probe turn.
 *
 * Commands:
 *   fetch                     pull the leaderboard through the logged-in browser
 *                             (a plain HTTP GET meets Cloudflare; the browser
 *                             context the bridge already runs does not) and
 *                             store the baseline
 *   parse <file|->            ingest a saved snapshot (rendered HTML or the
 *                             markdown a reader tool emits from it)
 *   show                      print the stored baseline
 *   label <file|->            attribute telemetry (JSON) to a model — one task,
 *                             { turns: [...] }, or { tasks: [...] } to accumulate
 *                             a session's independent tasks
 *
 * Measurement JSON — one turn or a task of turns (stats are per TASK, so feed
 * the whole task when you can):
 *   { "turns": [ { "durationSec": 91, "outputText": "...",
 *                  "bashCount": 4, "bashFailures": 1,
 *                  "toolCallCount": 7, "toolHallucinations": 0 } ] }
 * `outputTokens` may replace `outputText`; bash/tool calls may be arrays of
 * `{ failed }` / `{ hallucinated }` flags instead of counts.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ingestSnapshot, readBaseline, baselineSummary } from "../src/fingerprint/telemetry/baseline.mjs";
import { readTaskRecords } from "../src/fingerprint/telemetry/capture.mjs";
import { labelTasks, priorStatus, SIGMA_LOG, CONFIDENCE_THRESHOLD, MIN_LOG_MARGIN } from "../src/fingerprint/telemetry/identify.mjs";

const [command, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const numberFlag = (name, fallback) => {
  const raw = flag(name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`--${name} must be a number, got "${raw}"`);
    process.exit(2);
  }
  return n;
};

const dataDir = flag("data", path.join(os.homedir(), ".arena-bridge"));

function readInput(file) {
  const text = (file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8")).trim();
  if (!text) {
    console.error(`input ${file === "-" ? "(stdin)" : file} is empty`);
    process.exit(2);
  }
  return text;
}

if (command === "fetch") {
  const { loadDotEnv, loadConfig } = await import("../src/config.mjs");
  const { CredentialStore } = await import("../src/credentials.mjs");
  const { ArenaBrowser } = await import("../src/arena-login.mjs");
  const { requireSecret } = await import("../src/secret.mjs");

  const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
  const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
  const secret = requireSecret(dotEnv);
  const credentials = new CredentialStore({ filePath: config.credentialsFile, secret, omniDbPath: config.omniDbPath, omniRoot: config.omniRoot }).load();
  const cred = credentials.primary();
  if (!cred) {
    console.error("no account in the credential store; run bin/login.mjs first");
    process.exit(1);
  }
  const browser = new ArenaBrowser({ omniRoot: config.omniRoot, chromePath: config.chromePath, proxy: config.proxy });
  const page = await browser.getPage(cred, "fingerprint");
  const timeoutSec = numberFlag("challenge-timeout", 90);

  console.log("loading https://arena.ai/leaderboard/agent ...");
  await page.goto("https://arena.ai/leaderboard/agent", { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => undefined);

  // The leaderboard route sits behind a Cloudflare interstitial that clears
  // itself — poll until the table is actually in the DOM.
  let html = "";
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => "");
    if (/<table[\s\S]*<\/table>/i.test(html)) break;
    await page.locator("input[type='checkbox'], .cf-turnstile").click({ timeout: 1_000 }).catch(() => undefined);
  }
  await browser.close().catch(() => {});

  if (!/<table[\s\S]*<\/table>/i.test(html)) {
    console.error(`the leaderboard did not render within ${timeoutSec}s (Cloudflare challenge did not clear on this route).
  fallback: save the page from a browser and run: telemetry-baseline.mjs parse <file>`);
    process.exit(1);
  }
  const result = ingestSnapshot(dataDir, html, { source: "browser-html" });
  if (!result.stored) {
    console.error(`fetch succeeded but parsing failed: ${result.reason}`);
    process.exit(1);
  }
  console.log(`stored ${result.models} model(s), snapshot dated ${result.snapshotDate ?? "?"} → ${path.join(dataDir, "telemetry-baseline.json")}`);
  process.exit(0);
}

if (command === "parse") {
  const file = args[0];
  if (!file) {
    console.error("usage: telemetry-baseline.mjs parse <file|-> [--data dir]");
    process.exit(2);
  }
  const result = ingestSnapshot(dataDir, readInput(file));
  if (!result.stored) {
    console.error(`parse failed: ${result.reason}`);
    process.exit(1);
  }
  console.log(`stored ${result.models} model(s), snapshot dated ${result.snapshotDate ?? "?"} → ${path.join(dataDir, "telemetry-baseline.json")}`);
  process.exit(0);
}

if (command === "show") {
  const baseline = readBaseline(dataDir);
  if (!baseline.models.length) {
    console.log(`no baseline at ${path.join(dataDir, "telemetry-baseline.json")} — run fetch (or parse) first`);
    process.exit(0);
  }
  const filter = (flag("model", "") || "").toLowerCase();
  const models = baseline.models.filter((m) => !filter || m.name.toLowerCase().includes(filter));
  if (hasFlag("json")) {
    console.log(JSON.stringify({ ...baseline, models }, null, 2));
    process.exit(0);
  }
  const pct = (s) => (s ? `${s.value.toFixed(2)}%±${s.ci.toFixed(2)}` : "N/A");
  const num = (v, unit = "") => (v == null ? "N/A" : `${v}${unit}`);
  console.log(`baseline: ${baseline.models.length} model(s), snapshot ${baseline.snapshotDate ?? "?"}, fetched ${baseline.fetchedAt ?? "?"}`);
  for (const m of models) {
    console.log(
      `#${String(m.rank ?? "?").padEnd(3)} ${m.name.padEnd(52)} time=${num(m.timePerTaskMin?.toFixed(1), "min").padEnd(9)} ` +
      `tokens=${num(m.outputTokensPerTask ? Math.round(m.outputTokensPerTask / 1000) : null, "K").padEnd(7)} ` +
      `bashFail=${pct(m.signals.bashReliability).padEnd(16)} toolHallu=${pct(m.signals.toolHallucination).padEnd(16)} ` +
      `cost=$${num(m.costPerTaskUsd)}`
    );
  }
  process.exit(0);
}

if (command === "label") {
  const file = args[0];
  const tasksFile = flag("tasks", "");
  if (!file && !tasksFile) {
    console.error("usage: telemetry-baseline.mjs label <file|-> [--data dir] [--json] [--candidates \"a,b\"]\n" +
      "       telemetry-baseline.mjs label --tasks <jsonl|auto> [--chain substr] [--last 20]");
    process.exit(2);
  }
  const baseline = readBaseline(dataDir);
  const prior = priorStatus(baseline);
  if (!prior.ready) {
    console.error(`baseline not usable (${prior.reason}); run fetch (or parse) first`);
    process.exit(1);
  }
  let tasks;
  if (tasksFile) {
    // Task records the bridge captured passively (telemetry-tasks.jsonl).
    // Their fields are the labeler's per-task input shape, so they pass through.
    const source = tasksFile === "auto" ? null : tasksFile;
    const last = numberFlag("last", 20);
    const records = readTaskRecords(dataDir, { chain: flag("chain", ""), file: source });
    tasks = records.slice(-last);
    console.error(`# labeling ${tasks.length} task record(s) from ${source || path.join(dataDir, TASKS_FILE)}`);
  } else {
    let measurement;
    try {
      measurement = JSON.parse(readInput(file));
    } catch (error) {
      console.error(`measurement is not valid JSON: ${error.message}`);
      process.exit(2);
    }
    // One task, { turns: [...] } for a multi-turn task, or { tasks: [...] } /
    // an array for accumulation over a session's independent tasks.
    tasks = Array.isArray(measurement)
      ? measurement
      : Array.isArray(measurement?.tasks) ? measurement.tasks : [measurement];
  }
  const candidates = (flag("candidates", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const result = labelTasks(tasks, baseline, {
    candidates,
    sigmaTime: numberFlag("sigma-time", SIGMA_LOG.time),
    sigmaTokens: numberFlag("sigma-tokens", SIGMA_LOG.tokens),
    threshold: numberFlag("threshold", CONFIDENCE_THRESHOLD),
    minLogMargin: numberFlag("min-log-margin", MIN_LOG_MARGIN),
    topN: numberFlag("top-n", 10),
  });

  if (hasFlag("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`tasks: ${result.tasksUsed ?? 0}/${result.tasks ?? tasks.length} carried evidence`);
    console.log(`features used: ${result.usedFeatures.join(", ") || "(none)"}`);
    for (const s of result.skipped) console.log(`  skipped ${s.feature}: ${s.reason}`);
    console.log("");
    if (!result.ranked.length) {
      console.log(`${result.status}: ${result.reason}`);
    } else {
      for (const r of result.ranked) {
        const feats = Object.entries(r.features).map(([k, v]) => `${k}=${v == null ? "—" : v.toFixed(2)}`).join(" ");
        console.log(`${(r.posterior * 100).toFixed(2).padStart(6)}%  ${r.model.padEnd(52)} logLik=${r.logLik.toFixed(2)}  ${feats}`);
      }
      console.log(`\nverdict: ${result.status}${result.model ? ` → ${result.model}` : ""} (${result.reason ?? "gates passed"})`);
    }
  }
  process.exit(0);
}

console.error(`usage:
  telemetry-baseline.mjs fetch                          pull the leaderboard via the logged-in browser
  telemetry-baseline.mjs parse <file|->                 ingest a saved snapshot (HTML or markdown)
  telemetry-baseline.mjs show [--model substr] [--json] print the stored baseline
  telemetry-baseline.mjs label <file|->                 attribute telemetry (JSON) to a model
  telemetry-baseline.mjs label --tasks <jsonl|auto>     label captured task records instead
       [--chain substr] [--last 20]                     of a measurement file
  options: --data <dir> (default ~/.arena-bridge)`);
process.exit(2);
