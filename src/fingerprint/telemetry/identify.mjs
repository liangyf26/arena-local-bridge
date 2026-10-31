/**
 * fingerprint/telemetry/identify.mjs — attribute a task's telemetry to a model
 *
 * The leaderboard prior (baseline.mjs) publishes, for each of the ~55 candidate
 * classes, a Time/Task P50, an Output Tokens/Task P50, a bash-failure rate and
 * a tool-hallucination rate. The bridge measures the same four quantities
 * passively, for free, on every turn. This file asks: which class makes the
 * measurement most likely?
 *
 * Likelihoods, one per feature:
 *   time, tokens — log-normal centred on the published P50. Within-model spread
 *     is NOT published, so it is an assumption (SIGMA_LOG), not a finding; it is
 *     an option for exactly that reason.
 *   bash, tools  — beta-binomial. The published rate is a mean with a ± CI, and
 *     the CI is what turns it into a per-observation likelihood: the narrower
 *     the published interval, the more a measured deviation counts against
 *     that class.
 *
 * Two structural facts shape the output. A systematic multiplicative bias in
 * our measurements (the bridge under-counting tokens, say) shifts every
 * class's log-likelihood by the same constant and therefore cancels in the
 * posterior — the labeler is robust to scale error, sensitive only to spread
 * error. And a class with a missing statistic is scored on that feature at the
 * population-average log-likelihood (the mean over classes that publish it) —
 * treating the unknown parameter as drawn from the population. Skipping the
 * feature for that class instead would hand every N/A class one fewer chance
 * to be penalised, and a leaderboard's N/A is not missing at random: it marks
 * exactly the new and obscure classes.
 *
 * Like fingerprint/index.mjs, an attribution is a guess with a confidence.
 * This prior is one ensemble vote, never the whole verdict: telemetry alone
 * plausibly separates families and effort tiers, not siblings.
 */
import { baselineSummary } from "./baseline.mjs";

/**
 * Within-model log-space spread, assumed. 0.9 means a task's duration plausibly
 * lands within ~2.5× of the published P50 either way. Tuned by feel against the
 * spread BETWEEN classes (adjacent classes must stay distinguishable); if real
 * bridge data says otherwise, pass explicit sigmas.
 */
export const SIGMA_LOG = { time: 0.9, tokens: 0.8 };

/** The published ± is read as a 95% CI. */
export const CI_Z = 1.96;

/** Fallback beta concentration when a published rate carries no ±. */
export const DEFAULT_CONCENTRATION = 200;

/**
 * Attribution gates. Telemetry evidence is weak per turn, so the margin asks
 * for the winner to be at least e≈2.7× likelier than the runner-up in
 * posterior odds — below that the honest answer is "unresolved", with the
 * ranking attached.
 */
export const CONFIDENCE_THRESHOLD = 0.6;
export const MIN_LOG_MARGIN = 1.0;

/* ------------------------------------------------------------------- math */

export function logGamma(x) {
  // Lanczos, g=7, n=9 — good to ~1e-13 over the ranges we use.
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Log-normal density at x (x > 0) for a distribution with the given median. */
export function logNormalLogPdf(x, median, sigma) {
  if (!(x > 0) || !(median > 0) || !(sigma > 0)) return null;
  const z = (Math.log(x) - Math.log(median)) / sigma;
  return -0.5 * z * z - Math.log(sigma) - 0.5 * Math.log(2 * Math.PI) - Math.log(x);
}

/**
 * Beta(α, β) concentration from a published mean and ± CI half-width.
 * mean(1-mean)/(α+β+1) = sd² solved for α+β, floored so a rounding-flat CI
 * (or a rate at 0/1) cannot demand an infinite sample.
 */
export function betaFromCi(mean, ci, { defaultConcentration = DEFAULT_CONCENTRATION } = {}) {
  if (!(mean > 0) || mean >= 1) return null;
  const sd = (ci != null && ci > 0 ? ci : 0) / CI_Z;
  const concentration = sd > 0
    ? Math.min(Math.max((mean * (1 - mean)) / (sd * sd) - 1, 2), 1e6)
    : defaultConcentration;
  return { alpha: mean * concentration, beta: (1 - mean) * concentration };
}

/** Beta-binomial predictive log-pmf of k successes in n trials. */
export function betaBinomialLogPmf(k, n, alpha, beta) {
  if (!(n >= 0) || !(k >= 0) || k > n) return null;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
    + logGamma(alpha + k) + logGamma(beta + n - k) - logGamma(alpha + beta + n)
    + logGamma(alpha + beta) - logGamma(alpha) - logGamma(beta);
}

/* ------------------------------------------------------------ measurement */

/** Rough token estimate for reply text: CJK ≈ 1 token/char, else ≈ 4 chars. */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if ((code >= 0x3040 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
  }
  const other = [...s].length - cjk;
  return Math.ceil(cjk + other / 4);
}

/**
 * One turn of bridge-side measurement. Numbers win; arrays of
 * `{ failed }` / `{ hallucinated }` flags are accepted for the caller's
 * convenience and counted here.
 */
function normalizeTurn(turn = {}) {
  const bashFlags = Array.isArray(turn.bashCalls) ? turn.bashCalls : null;
  const toolFlags = Array.isArray(turn.toolCalls) ? turn.toolCalls : null;
  return {
    durationSec: Number.isFinite(turn.durationSec) && turn.durationSec > 0 ? turn.durationSec : 0,
    outputTokens: Number.isFinite(turn.outputTokens) && turn.outputTokens > 0
      ? turn.outputTokens
      : estimateTokens(turn.outputText),
    bash: {
      calls: bashFlags ? bashFlags.length : (Number(turn.bashCount) || 0),
      failures: bashFlags ? bashFlags.filter((c) => c && c.failed).length : (Number(turn.bashFailures) || 0),
    },
    tools: {
      calls: toolFlags ? toolFlags.length : (Number(turn.toolCallCount) || 0),
      hallucinations: toolFlags ? toolFlags.filter((c) => c && c.hallucinated).length : (Number(turn.toolHallucinations) || 0),
    },
  };
}

/**
 * Aggregate a measurement input into task-level evidence. Accepts a single
 * turn's fields or `{ turns: [...] }` — a task that spanned several bridge
 * turns sums its durations and tokens and pools its command/tool counts,
 * because that is the granularity the published per-task statistics live at.
 */
export function aggregateMeasurement(input = {}) {
  const turns = Array.isArray(input?.turns) && input.turns.length ? input.turns : [input];
  const agg = { turns: turns.length, durationSec: 0, outputTokens: 0, bash: { calls: 0, failures: 0 }, tools: { calls: 0, hallucinations: 0 } };
  for (const raw of turns) {
    const t = normalizeTurn(raw);
    agg.durationSec += t.durationSec;
    agg.outputTokens += t.outputTokens;
    agg.bash.calls += t.bash.calls;
    agg.bash.failures += t.bash.failures;
    agg.tools.calls += t.tools.calls;
    agg.tools.hallucinations += t.tools.hallucinations;
  }
  return agg;
}

/* ------------------------------------------------------------------ label */

function featureLogLik(feature, agg, model, sigma) {
  switch (feature) {
    case "time":
      return model.timePerTaskMin != null
        ? logNormalLogPdf(agg.durationSec / 60, model.timePerTaskMin, sigma.time)
        : null;
    case "tokens":
      return model.outputTokensPerTask != null
        ? logNormalLogPdf(agg.outputTokens, model.outputTokensPerTask, sigma.tokens)
        : null;
    case "bash": {
      const rate = model.signals?.bashReliability;
      if (!rate || agg.bash.calls <= 0) return null;
      // The published value is a FAILURE rate ("runs shell commands with the
      // fewest failures" is how the leaderboard ranks its lowest number).
      const params = betaFromCi(rate.value / 100, rate.ci);
      if (!params) return null;
      return betaBinomialLogPmf(agg.bash.failures, agg.bash.calls, params.alpha, params.beta);
    }
    case "tools": {
      const rate = model.signals?.toolHallucination;
      if (!rate || agg.tools.calls <= 0) return null;
      const params = betaFromCi(rate.value / 100, rate.ci);
      if (!params) return null;
      return betaBinomialLogPmf(agg.tools.hallucinations, agg.tools.calls, params.alpha, params.beta);
    }
    default:
      return null;
  }
}

const FEATURES = ["time", "tokens", "bash", "tools"];

/**
 * Label one task's telemetry against the baseline.
 *
 * Returns `attributed` / `unresolved` / `failed` exactly like
 * fingerprint/index.mjs: `unresolved` keeps the full ranking (a near-miss is
 * information), `failed` means no feature carried any evidence at all.
 */
/**
 * Label one or more tasks' telemetry against the baseline.
 *
 * Tasks are independent samples of a class's per-task distribution, so their
 * log-likelihoods add — this accumulation over a session's tasks is how the
 * prior becomes decisive; a single task rarely is. `measurement` may be one
 * task's fields, `{ turns: [...] }`, or `{ tasks: [...] }` / an array of tasks.
 *
 * Returns `attributed` / `unresolved` / `failed` exactly like
 * fingerprint/index.mjs: `unresolved` keeps the full ranking (a near-miss is
 * information), `failed` means no feature carried any evidence at all.
 */
export function labelTasks(tasks, baseline, opts = {}) {
  const models = (opts.candidates?.length ? baseline.models.filter((m) => opts.candidates.includes(m.name)) : baseline.models) ?? [];
  if (!models.length) {
    return { status: "failed", model: null, confidence: null, margin: null, nearMiss: null, reason: "no candidate models in the baseline", ranked: [], usedFeatures: [], skipped: [], tasks: 0 };
  }
  const sigma = {
    time: opts.sigmaTime ?? SIGMA_LOG.time,
    tokens: opts.sigmaTokens ?? SIGMA_LOG.tokens,
  };

  // Accumulator per class: summed LL per feature, and which features the class
  // has OWN published statistics for (any task).
  const acc = new Map(models.map((m) => [m.name, { model: m, logLik: 0, features: {}, ownFeatures: new Set() }]));
  let tasksUsed = 0;

  for (const raw of tasks) {
    const agg = aggregateMeasurement(raw);

    // Which features does THIS task carry evidence for?
    const taskFeatures = [];
    if (agg.durationSec > 0) taskFeatures.push("time");
    if (agg.outputTokens > 0) taskFeatures.push("tokens");
    if (agg.bash.calls > 0) taskFeatures.push("bash");
    if (agg.tools.calls > 0) taskFeatures.push("tools");
    if (!taskFeatures.length) continue;
    tasksUsed += 1;

    // Own LLs for this task, then population-mean imputation within the task,
    // so every class accumulates the same feature set per task and an N/A
    // neither helps nor hurts.
    for (const feature of taskFeatures) {
      const own = new Map();
      for (const entry of acc.values()) {
        const ll = featureLogLik(feature, agg, entry.model, sigma);
        if (ll != null) own.set(entry.model.name, ll);
      }
      if (!own.size) continue;
      const mean = [...own.values()].reduce((s, v) => s + v, 0) / own.size;
      for (const entry of acc.values()) {
        const ll = own.get(entry.model.name) ?? mean;
        entry.features[feature] = (entry.features[feature] ?? 0) + ll;
        entry.logLik += ll;
        if (own.has(entry.model.name)) entry.ownFeatures.add(feature);
      }
    }
  }

  const skipped = [];
  if (!tasksUsed) {
    skipped.push({ feature: "all", reason: "no task carried a duration, tokens, bash or tool evidence" });
    return {
      status: "failed",
      model: null,
      confidence: null,
      margin: null,
      nearMiss: null,
      reason: skipped[0].reason,
      ranked: [],
      usedFeatures: [],
      skipped,
      tasks: tasks.length,
    };
  }

  const usedFeatures = FEATURES.filter((f) => [...acc.values()].some((e) => e.ownFeatures.has(f)));
  const carried = [...acc.values()].filter((e) => e.ownFeatures.size > 0);
  if (!carried.length || !usedFeatures.length) {
    return {
      status: "failed",
      model: null,
      confidence: null,
      margin: null,
      nearMiss: null,
      reason: "no class has published statistics for any measured feature",
      ranked: [],
      usedFeatures: [],
      skipped,
      tasks: tasks.length,
    };
  }

  // Softmax over log-likelihoods (uniform prior over classes).
  const max = Math.max(...carried.map((r) => r.logLik));
  let total = 0;
  for (const r of carried) {
    r.posterior = Math.exp(r.logLik - max);
    total += r.posterior;
  }
  for (const r of carried) r.posterior /= total;
  carried.sort((a, b) => b.posterior - a.posterior);

  const top = carried[0];
  const second = carried[1];
  const topName = top.model.name;
  const margin = second ? Math.log(top.posterior / second.posterior) : Infinity;
  const confidence = top.posterior;
  const attributed = confidence >= (opts.threshold ?? CONFIDENCE_THRESHOLD) && margin >= (opts.minLogMargin ?? MIN_LOG_MARGIN);

  return {
    status: attributed ? "attributed" : "unresolved",
    model: attributed ? topName : null,
    confidence,
    margin,
    nearMiss: attributed ? null : topName,
    reason: attributed
      ? null
      : `top guess ${topName} at ${(confidence * 100).toFixed(1)}% / ${Number.isFinite(margin) ? `${margin.toFixed(2)} log-margin` : "no runner-up"}; below the ${((opts.threshold ?? CONFIDENCE_THRESHOLD) * 100).toFixed(0)}% / ${(opts.minLogMargin ?? MIN_LOG_MARGIN).toFixed(2)} gates`,
    ranked: carried.slice(0, opts.topN ?? 10).map((r) => ({ model: r.model.name, posterior: r.posterior, logLik: r.logLik, features: r.features })),
    usedFeatures,
    skipped,
    tasks: tasks.length,
    tasksUsed,
  };
}

/** Single-task convenience wrapper over labelTasks. */
export function labelMeasurement(measurement, baseline, opts = {}) {
  return labelTasks([measurement], baseline, opts);
}

/** What the current baseline can support, for callers deciding whether to ask. */
export function priorStatus(baseline) {
  const summary = baselineSummary(baseline);
  const ready = summary.models >= 2 && summary.withTime >= 2 && summary.withTokens >= 2;
  return { ready, summary, reason: ready ? null : "baseline lacks models or the time/tokens statistics" };
}
