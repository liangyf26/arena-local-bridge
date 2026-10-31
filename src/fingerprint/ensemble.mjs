/**
 * fingerprint/ensemble.mjs — fuse the identification signals into one verdict
 *
 * The system has several ways to guess which of the ~55 leaderboard classes
 * answered: the telemetry prior (passive, always on, separates families and
 * tiers), the numeric fingerprint (precise, needs a reference bank), and
 * LLMmap-style behaviour probes (cheap, weak). Each alone is wrong often
 * enough that no single one should ever emit a final label — but their
 * failure modes are nearly independent, so the probability of two of them
 * being wrong in the SAME direction is the product of their error rates.
 * That product is what this module trades on.
 *
 * Three jobs:
 *   align   map each signal's model names onto the canonical 55-class space
 *   fuse    weighted log-opinion pool over the aligned votes
 *   gate    attributed only when enough signals' top picks AGREE and the fused
 *           posterior clears the confidence/margin gates — disagreement is
 *           kept and shown, because it means a signal is polluted or a model
 *           is imitating another
 *
 * Design rules inherited from telemetry/identify.mjs: a signal votes only
 * over the classes it can see, and a class outside a signal's support is
 * scored at that signal's MEAN log-vote — abstention must not be an
 * advantage (the same argument that forbids skipping features for N/A
 * classes). And like fingerprint/index.mjs, the output is a guess with a
 * confidence: below the gates the honest answer is "unresolved", with the
 * ranking and the disagreement attached.
 *
 * Follow-ups this file deliberately does not do: the numeric identify path
 * does not auto-append its votes yet (record them with ensemble-cli vote),
 * and LLMmap does not exist as a signal.
 */
import fs from "node:fs";
import path from "node:path";
import { readBaseline } from "./telemetry/baseline.mjs";
import { readTaskRecords } from "./telemetry/capture.mjs";
import { labelTasks } from "./telemetry/identify.mjs";

/**
 * Per-signal reliability weights. The numeric fingerprint is worth two
 * telemetry votes when its bank exists; LLMmap in agent environments is
 * barely better than a coin, so its vote counts for half.
 */
export const DEFAULT_WEIGHTS = { telemetry: 1, numeric: 2, llmmap: 0.5 };

export const CONFIDENCE_THRESHOLD = 0.6;
export const MIN_LOG_MARGIN = 1.0;
/** How many signals must agree on the top pick before a label is emitted. */
export const DEFAULT_MIN_AGREE = 2;

/** A signal voting 0 for a class is evidence, not an error to crash on. */
const POSTERIOR_FLOOR = 1e-9;

export function votesPath(dataDir) {
  return path.join(dataDir, "identification-votes.jsonl");
}

/* ------------------------------------------------------------------ align */

/** "GPT-6 Luna (Low)" and "gpt-6_luna-low" both normalize to "gpt6lunalow". */
export function normalizeName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Map one signal's model name onto the canonical class list.
 *
 * Order: explicit alias → exact normalized → containment. Containment only
 * resolves when UNIQUE: a raw "gpt-6 luna" without a tier sits inside three
 * different canonical classes, and guessing one would be manufacturing a
 * label — so ambiguous names are dropped and reported instead.
 */
export function alignName(raw, canonicalNames, aliases = {}) {
  if (raw == null || canonicalNames.length === 0) return null;
  const norm = normalizeName(raw);
  if (!norm) return null;
  const aliasHit = aliases[raw] ?? aliases[norm];
  if (aliasHit && canonicalNames.includes(aliasHit)) return aliasHit;
  const exact = canonicalNames.find((c) => normalizeName(c) === norm);
  if (exact) return exact;
  const contained = canonicalNames.filter((c) => {
    const cn = normalizeName(c);
    return cn !== norm && (cn.includes(norm) || norm.includes(cn));
  });
  return contained.length === 1 ? contained[0] : null;
}

/* ------------------------------------------------------------------- fuse */

/**
 * Fuse aligned signal votes.
 *
 * `signals` is `[{ signal, weight?, votes: [{ model, posterior }], notes? }]`
 * — posteriors need not sum to 1, they are renormalized after alignment.
 * `canonicalNames` is the target class space (the baseline's 55 names).
 *
 * Returns attributed / unresolved / failed like the rest of the
 * identification stack, with the per-signal agreement breakdown attached.
 */
export function fuseVotes(signals, canonicalNames, opts = {}) {
  if (!canonicalNames.length) {
    return failedFusion("no canonical classes — is the leaderboard baseline loaded?", opts);
  }
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const aliases = opts.aliases || {};
  const notes = [];

  // Align every vote onto the canonical space; duplicates within a signal add.
  const aligned = [];
  for (const s of Array.isArray(signals) ? signals : []) {
    const seen = new Map();
    let dropped = 0;
    for (const v of Array.isArray(s.votes) ? s.votes : []) {
      const canonical = alignName(v?.model, canonicalNames, aliases);
      const p = Number(v?.posterior);
      if (!canonical || !Number.isFinite(p) || p <= 0) {
        dropped += 1;
        continue;
      }
      seen.set(canonical, (seen.get(canonical) || 0) + p);
    }
    if (dropped) notes.push(`${s.signal}: ${dropped} vote(s) matched no canonical class — dropped`);
    if (!seen.size) {
      notes.push(`${s.signal}: no usable votes after alignment`);
      continue;
    }
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    if (!(total > 0)) continue;
    const logVotes = new Map([...seen].map(([m, p]) => [m, Math.log(Math.max(p / total, POSTERIOR_FLOOR))]));
    aligned.push({
      signal: String(s.signal || "unnamed"),
      weight: Number.isFinite(s.weight) && s.weight > 0 ? s.weight : (Number(weights[s.signal]) || 1),
      logVotes,
      visible: seen.size,
      dropped,
      top: maxKey(logVotes),
    });
  }

  if (!aligned.length) {
    return failedFusion("no signal produced an aligned vote" + (notes.length ? ` — ${notes.join("; ")}` : ""), opts, notes);
  }

  // A class outside a signal's support is scored at that signal's mean
  // log-vote, so abstention neither helps nor hurts (see module header).
  for (const s of aligned) {
    s.meanLog = [...s.logVotes.values()].reduce((a, b) => a + b, 0) / s.logVotes.size;
  }
  const carried = [];
  for (const name of canonicalNames) {
    let score = 0;
    let seenBy = 0;
    for (const s of aligned) {
      const own = s.logVotes.get(name);
      score += s.weight * (own !== undefined ? own : s.meanLog);
      if (own !== undefined) seenBy += 1;
    }
    if (seenBy > 0) carried.push({ model: name, logLik: score, seenBy });
  }
  if (!carried.length) {
    return failedFusion("no canonical class is visible to any aligned signal", opts, notes);
  }

  // Softmax over fused log-scores (uniform prior over classes).
  const max = Math.max(...carried.map((r) => r.logLik));
  let total = 0;
  for (const r of carried) {
    r.raw = Math.exp(r.logLik - max);
    total += r.raw;
  }
  for (const r of carried) r.posterior = r.raw / total;
  carried.sort((a, b) => b.posterior - a.posterior);

  const top = carried[0];
  const second = carried[1];
  const margin = second ? Math.log(top.posterior / second.posterior) : Infinity;
  const confidence = top.posterior;

  // Agreement: which signals' own top pick equals the fused top pick?
  const agreeing = aligned.filter((s) => s.top === top.model).map((s) => s.signal);
  const disagreeing = aligned.filter((s) => s.top !== top.model).map((s) => ({ signal: s.signal, top: s.top }));
  const minAgree = Math.max(1, Math.floor(opts.minAgree ?? DEFAULT_MIN_AGREE));
  const threshold = opts.threshold ?? CONFIDENCE_THRESHOLD;
  const minLogMargin = opts.minLogMargin ?? MIN_LOG_MARGIN;

  let status;
  let model = null;
  let nearMiss = null;
  let reason = null;
  if (aligned.length < minAgree) {
    status = "unresolved";
    nearMiss = top.model;
    reason =
      `${aligned.length} signal(s) voted; the agreement gate needs ${minAgree} — ` +
      `a single signal must never carry a label alone`;
  } else if (agreeing.length < minAgree) {
    status = "unresolved";
    nearMiss = top.model;
    reason =
      `top guess ${top.model} agreed by ${agreeing.length}/${aligned.length} signal(s) ` +
      `(needs ${minAgree}); disagreeing: ${disagreeing.map((d) => `${d.signal}→${d.top}`).join(", ") || "none"}`;
  } else if (confidence < threshold || margin < minLogMargin) {
    status = "unresolved";
    nearMiss = top.model;
    reason =
      `top guess ${top.model} at ${(confidence * 100).toFixed(1)}% / ${Number.isFinite(margin) ? `${margin.toFixed(2)} log-margin` : "no runner-up"}; ` +
      `below the ${(threshold * 100).toFixed(0)}% / ${minLogMargin.toFixed(2)} gates`;
  } else {
    status = "attributed";
    model = top.model;
  }

  const topN = opts.topN ?? 10;
  return {
    status,
    model,
    confidence,
    margin,
    nearMiss,
    reason,
    ranked: carried.slice(0, topN).map((r) => ({ model: r.model, posterior: r.posterior, logLik: r.logLik, seenBy: r.seenBy })),
    agreement: {
      required: minAgree,
      agreeing,
      disagreeing,
    },
    signals: aligned.map((s) => ({
      signal: s.signal,
      weight: s.weight,
      visibleClasses: s.visible,
      dropped: s.dropped,
      top: s.top,
    })),
    notes,
  };
}

function maxKey(logMap) {
  let best = null;
  let bestV = -Infinity;
  for (const [k, v] of logMap) {
    if (v > bestV) {
      best = k;
      bestV = v;
    }
  }
  return best;
}

function failedFusion(reason, opts, notes = []) {
  return {
    status: "failed",
    model: null,
    confidence: null,
    margin: null,
    nearMiss: null,
    reason,
    ranked: [],
    agreement: { required: Math.max(1, Math.floor(opts?.minAgree ?? DEFAULT_MIN_AGREE)), agreeing: [], disagreeing: [] },
    signals: [],
    notes,
  };
}

/* ------------------------------------------------------ telemetry adapter */

/**
 * Derive the telemetry signal's vote for one session from the passively
 * captured task records — no separate bookkeeping: the capture file IS the
 * evidence, and the labeler turns it into a posterior over the 55 classes.
 * Returns null when the session has no usable task records.
 */
export function telemetryVoteFromTasks(dataDir, sessionId, baseline, { last = 20, sigmaTime, sigmaTokens } = {}) {
  const records = readTaskRecords(dataDir, { chain: sessionId });
  const usable = records.filter((r) => (r.durationSec > 0 || r.outputTokens > 0 || r.toolCallCount > 0));
  if (!usable.length) return null;
  const result = labelTasks(usable.slice(-last), baseline, {
    topN: 55,
    ...(sigmaTime !== undefined ? { sigmaTime } : {}),
    ...(sigmaTokens !== undefined ? { sigmaTokens } : {}),
  });
  if (!result.ranked.length) {
    return { signal: "telemetry", votes: [], notes: [`labeler said: ${result.reason}`] };
  }
  return {
    signal: "telemetry",
    votes: result.ranked.map((r) => ({ model: r.model, posterior: r.posterior })),
    notes: [`${result.tasksUsed} task(s) accumulated, features: ${result.usedFeatures.join(", ")}`],
  };
}

/** The canonical class space — the baseline's model names, in board order. */
export function canonicalClasses(baseline) {
  return (baseline?.models ?? []).map((m) => m.name);
}

export function loadBaselineOrThrow(dataDir) {
  const baseline = readBaseline(dataDir);
  if (!baseline.models.length) {
    throw new Error(`no leaderboard baseline at ${dataDir} — run telemetry-baseline.mjs fetch (or parse) first`);
  }
  return baseline;
}

/* ------------------------------------------------------------------ store */

/**
 * Persist one signal vote. Stored votes exist for evidence that costs turns
 * (a numeric probe attribution) or arrives out-of-band (LLMmap); the
 * telemetry vote is derived on demand and never needs storing.
 */
export function appendVote(dataDir, { sessionId, signal, votes, notes = [], weight, at = new Date().toISOString() }) {
  if (!sessionId || !signal || !Array.isArray(votes)) {
    throw new TypeError("appendVote needs sessionId, signal and a votes array");
  }
  const record = { at, sessionId, signal, ...(weight !== undefined ? { weight } : {}), votes, notes };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(votesPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

/** Read stored votes, optionally for one session. Tolerates a torn last line. */
export function readVotes(dataDir, { sessionId } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(votesPath(dataDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (sessionId && rec.sessionId !== sessionId) continue;
      if (Array.isArray(rec.votes)) out.push(rec);
    } catch {
      /* torn final line after a crash mid-append is normal */
    }
  }
  return out;
}
