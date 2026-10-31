#!/usr/bin/env node
/**
 * bin/ensemble-cli.mjs — the final identification verdict
 *
 * Fuses every signal that has something to say about a session into one
 * gated attribution over the 55 leaderboard classes:
 *
 *   fuse <sessionId>    telemetry vote is DERIVED from the captured task
 *                       records; numeric/LLMmap votes come from the stored
 *                       vote file (see `vote`). Labelled only when enough
 *                       signals agree AND the fused posterior clears the
 *                       gates — otherwise the ranking and the disagreement
 *                       are printed and the answer is "unresolved".
 *   vote <id> <signal>  record a stored vote (JSON: {votes:[{model,posterior}]})
 *   votes [sessionId]   list recorded votes
 *
 * Options: --data dir, --min-agree N, --threshold x, --min-log-margin y,
 *          --weight signal=w (repeatable), --aliases file (raw→canonical JSON),
 *          --last N (task records fed to the telemetry vote), --json.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  fuseVotes,
  appendVote,
  readVotes,
  telemetryVoteFromTasks,
  canonicalClasses,
  loadBaselineOrThrow,
  CONFIDENCE_THRESHOLD,
  MIN_LOG_MARGIN,
  DEFAULT_MIN_AGREE,
} from "../src/fingerprint/ensemble.mjs";

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
/** Repeatable `--weight signal=value`. */
const weightFlags = () => {
  const out = {};
  for (let i = 0; i < process.argv.length - 1; i++) {
    const m = /^--weight$/.exec(process.argv[i]);
    const kv = /^(telemetry|numeric|llmmap|[a-z0-9_-]+)=([\d.]+)$/.exec(process.argv[i + 1] || "");
    if (m && kv) out[kv[1]] = Number(kv[2]);
  }
  return out;
};
const loadAliases = () => {
  const file = flag("aliases", "");
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    console.error(`--aliases ${file} must be a JSON object of raw→canonical`);
    process.exit(2);
  } catch (error) {
    console.error(`cannot read --aliases ${file}: ${error.message}`);
    process.exit(2);
  }
};

const dataDir = flag("data", path.join(os.homedir(), ".arena-bridge"));

if (command === "fuse") {
  const sessionId = args[0];
  if (!sessionId) {
    console.error("usage: ensemble-cli.mjs fuse <sessionId> [--data dir] [--min-agree 2] [--json]");
    process.exit(2);
  }
  const baseline = loadBaselineOrThrow(dataDir);
  const signals = [];
  const telemetry = telemetryVoteFromTasks(dataDir, sessionId, baseline, { last: numberFlag("last", 20) });
  if (telemetry) signals.push(telemetry);
  for (const stored of readVotes(dataDir, { sessionId })) {
    signals.push({
      signal: stored.signal,
      ...(stored.weight !== undefined ? { weight: stored.weight } : {}),
      votes: stored.votes,
      notes: stored.notes,
    });
  }
  if (!signals.length) {
    console.error(
      `no votes for ${sessionId}: no captured task records and no stored votes.\n` +
      `the bridge captures task records as real turns complete; record probe results with: ensemble-cli.mjs vote <id> <signal> <file>`
    );
    process.exit(1);
  }
  const result = fuseVotes(signals, canonicalClasses(baseline), {
    minAgree: numberFlag("min-agree", DEFAULT_MIN_AGREE),
    threshold: numberFlag("threshold", CONFIDENCE_THRESHOLD),
    minLogMargin: numberFlag("min-log-margin", MIN_LOG_MARGIN),
    weights: weightFlags(),
    aliases: loadAliases(),
    topN: numberFlag("top-n", 10),
  });

  if (hasFlag("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const s of signals) {
      console.error(`# signal ${s.signal}: ${s.votes.length} vote(s)${s.notes?.length ? ` (${s.notes.join("; ")})` : ""}`);
    }
    for (const note of result.notes) console.error(`# ${note}`);
    console.log("");
    for (const r of result.ranked) {
      console.log(`${(r.posterior * 100).toFixed(2).padStart(6)}%  ${r.model.padEnd(52)} logLik=${r.logLik.toFixed(2)}  seenBy=${r.seenBy}`);
    }
    console.log(`\nagreement: ${result.agreement.agreeing.join(", ") || "(none)"} — ${result.agreement.agreeing.length}/${result.signals.length} signals, gate needs ${result.agreement.required}`);
    console.log(`verdict: ${result.status}${result.model ? ` → ${result.model}` : ""} (${result.reason ?? "gates passed"})`);
  }
  process.exit(0);
}

if (command === "vote") {
  const [sessionId, signal, file] = args;
  if (!sessionId || !signal || !file) {
    console.error("usage: ensemble-cli.mjs vote <sessionId> <signal> <file|-> [--weight w] [--data dir]");
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse((file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8")).trim());
  } catch (error) {
    console.error(`vote file is not valid JSON: ${error.message}`);
    process.exit(2);
  }
  const votes = Array.isArray(parsed) ? parsed : parsed.votes;
  if (!Array.isArray(votes) || !votes.length) {
    console.error("vote JSON must be {votes:[{model,posterior}]} or an array of those pairs");
    process.exit(2);
  }
  const record = appendVote(dataDir, {
    sessionId,
    signal,
    votes,
    weight: numberFlag("weight", undefined),
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  });
  console.log(`stored: ${signal} vote for ${sessionId}, ${record.votes.length} pair(s) → ${path.join(dataDir, "identification-votes.jsonl")}`);
  process.exit(0);
}

if (command === "votes") {
  const sessionId = args[0];
  const records = readVotes(dataDir, sessionId ? { sessionId } : {});
  if (!records.length) {
    console.log(`no stored votes at ${path.join(dataDir, "identification-votes.jsonl")}`);
    process.exit(0);
  }
  for (const r of records) {
    const top = r.votes.reduce((a, b) => ((b.posterior || 0) > (a?.posterior || 0) ? b : a), null);
    console.log(`${r.at}  ${String(r.sessionId).slice(0, 13).padEnd(13)}  ${r.signal.padEnd(10)}  ${r.votes.length} pair(s), top: ${top?.model ?? "?"}`);
  }
  process.exit(0);
}

console.error(`usage:
  ensemble-cli.mjs fuse <sessionId>            fuse all signals for a session into a verdict
  ensemble-cli.mjs vote <id> <signal> <file>   record a stored signal vote (file or - for stdin)
  ensemble-cli.mjs votes [sessionId]           list stored votes
  options: --data <dir> (default ~/.arena-bridge)`);
process.exit(2);
