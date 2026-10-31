/**
 * The telemetry labeler: math and attribution behavior.
 *
 * The math is tested on identities (lgamma against factorials, the
 * beta-binomial reducing to the binomial as concentration grows) because a
 * numerically wrong likelihood is indistinguishable from a wrong prior
 * downstream. The attribution behavior is tested on the discriminations the
 * published statistics actually support — a fast/short task must not be given
 * to an 18-minute/125K-token class — and on the honesty rules: missing
 * statistics marginalise out, feature-less measurements fail loudly, weak
 * evidence stays unresolved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  logGamma,
  logNormalLogPdf,
  betaFromCi,
  betaBinomialLogPmf,
  estimateTokens,
  aggregateMeasurement,
  labelMeasurement,
  labelTasks,
  priorStatus,
} from "../src/fingerprint/telemetry/identify.mjs";

// ── math ─────────────────────────────────────────────────────────────────

test("logGamma matches factorials", () => {
  assert.ok(Math.abs(logGamma(1) - Math.log(1)) < 1e-10);
  assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-10);
  assert.ok(Math.abs(logGamma(11) - Math.log(3628800)) < 1e-9);
  // Reflection: Γ(x)Γ(1-x) = π / sin(πx)
  const x = 0.3;
  assert.ok(Math.abs(logGamma(x) + logGamma(1 - x) - Math.log(Math.PI / Math.sin(Math.PI * x))) < 1e-10);
});

test("log-normal pdf peaks at the median and is scale-bias invariant", () => {
  const llAtMedian = logNormalLogPdf(18.1, 18.1, 0.9);
  const llFar = logNormalLogPdf(1.5, 18.1, 0.9);
  assert.ok(llAtMedian > llFar);
  // A multiplicative measurement bias adds a constant to every class's LL and
  // must cancel in the posterior ordering: scaling the observation by 0.5
  // while scaling every median by 0.5 preserves relative likelihoods.
  const a = logNormalLogPdf(60, 100, 0.8) - logNormalLogPdf(60, 20, 0.8);
  const b = logNormalLogPdf(30, 50, 0.8) - logNormalLogPdf(30, 10, 0.8);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test("beta concentration from CI: narrower CI means tighter beta", () => {
  const tight = betaFromCi(0.1577, 0.005);
  const loose = betaFromCi(0.1577, 0.05);
  const conc = (p) => p.alpha + p.beta;
  assert.ok(conc(tight) > conc(loose));
  // No ± at all → the documented default concentration.
  const noCi = betaFromCi(0.1577, null);
  assert.ok(Math.abs(conc(noCi) - 200) < 1e-9);
  assert.equal(betaFromCi(0, 0.01), null);
  assert.equal(betaFromCi(1, 0.01), null);
});

test("beta-binomial approaches the plain binomial as concentration grows", () => {
  const n = 10;
  const k = 3;
  const p = 0.3;
  const tight = betaFromCi(p, 1e-4); // huge concentration
  const predictive = betaBinomialLogPmf(k, n, tight.alpha, tight.beta);
  const binomial = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
    + k * Math.log(p) + (n - k) * Math.log(1 - p);
  // Concentration is capped at 1e6, so the convergence tolerance is loose but
  // still far tighter than any plausible mis-implementation.
  assert.ok(Math.abs(predictive - binomial) < 1e-3);
  // The prior predictive at k=0,n=0 is 1.
  assert.ok(Math.abs(betaBinomialLogPmf(0, 0, 2, 2) - 0) < 1e-12);
});

test("token estimation: CJK counts per char, latin per ~4 chars", () => {
  assert.equal(estimateTokens("hello world, this is a test of estimation"), 11);
  assert.equal(estimateTokens("这是一段中文测试文本"), 10);
  assert.equal(estimateTokens(""), 0);
});

// ── aggregation ──────────────────────────────────────────────────────────

test("task aggregation sums durations/tokens and pools counts", () => {
  const agg = aggregateMeasurement({
    turns: [
      { durationSec: 60, outputTokens: 1000, bashCalls: [{ failed: false }, { failed: true }], toolCallCount: 2, toolHallucinations: 1 },
      { durationSec: 30, outputText: "hello world this is text", bashCount: 1, bashFailures: 0, toolCalls: [{ hallucinated: false }] },
    ],
  });
  assert.equal(agg.turns, 2);
  assert.equal(agg.durationSec, 90);
  assert.equal(agg.outputTokens, 1006);
  assert.deepEqual(agg.bash, { calls: 3, failures: 1 });
  assert.deepEqual(agg.tools, { calls: 3, hallucinations: 1 });
});

// ── attribution ──────────────────────────────────────────────────────────

const BASELINE = {
  version: 1,
  models: [
    {
      name: "Big Slow (Max)", lab: "Anthropic", license: "Proprietary",
      signals: {
        bashReliability: { value: 15.77, ci: 0.5 },
        toolHallucination: { value: 0.57, ci: 0.13 },
      },
      timePerTaskMin: 18.1, outputTokensPerTask: 125200, costPerTaskUsd: 6.4,
    },
    {
      name: "Tiny Fast (Low)", lab: "OpenAI", license: "Proprietary",
      signals: {
        bashReliability: { value: 1.27, ci: 1.12 },
        toolHallucination: { value: 0.69, ci: 0.11 },
      },
      timePerTaskMin: 50 / 60, outputTokensPerTask: 3900, costPerTaskUsd: 0.01,
    },
    {
      name: "No Telemetry (Preview)", lab: "NewLab", license: "MIT",
      signals: { bashReliability: { value: 5, ci: 1 }, toolHallucination: null },
      timePerTaskMin: null, outputTokensPerTask: null, costPerTaskUsd: null,
    },
  ],
};

test("a fast short task attributes to the fast class, a slow long one to the slow class", () => {
  const fast = labelMeasurement({ durationSec: 45, outputTokens: 3600 }, BASELINE, { topN: 3 });
  assert.equal(fast.ranked[0].model, "Tiny Fast (Low)");
  const slow = labelMeasurement({ durationSec: 18 * 60, outputTokens: 120000 }, BASELINE, { topN: 3 });
  assert.equal(slow.ranked[0].model, "Big Slow (Max)");
  // And the posteriors are sharp on textbook measurements.
  assert.ok(fast.ranked[0].posterior > 0.9);
  assert.ok(slow.ranked[0].posterior > 0.9);
});

test("bash and tool evidence pull the ranking toward the matching rate", () => {
  // Two classes with near-identical speed/tokens but 12× apart in bash failure.
  const close = {
    version: 1,
    models: [
      { name: "Careful", lab: "A", signals: { bashReliability: { value: 1.3, ci: 0.5 } }, timePerTaskMin: 5, outputTokensPerTask: 40000 },
      { name: "Careless", lab: "B", signals: { bashReliability: { value: 15.8, ci: 0.5 } }, timePerTaskMin: 5, outputTokensPerTask: 40000 },
    ],
  };
  const manyFailures = labelMeasurement({ durationSec: 300, outputTokens: 40000, bashCount: 12, bashFailures: 4 }, close);
  assert.equal(manyFailures.ranked[0].model, "Careless");
  const noFailures = labelMeasurement({ durationSec: 300, outputTokens: 40000, bashCount: 12, bashFailures: 0 }, close);
  assert.equal(noFailures.ranked[0].model, "Careful");
  // Tool hallucinations count against the class with the lower published rate.
  const hallu = {
    version: 1,
    models: [
      { name: "Grounded", lab: "A", signals: { toolHallucination: { value: 0.6, ci: 0.1 } }, timePerTaskMin: 5, outputTokensPerTask: 40000 },
      { name: "Dreamy", lab: "B", signals: { toolHallucination: { value: 18, ci: 1.7 } }, timePerTaskMin: 5, outputTokensPerTask: 40000 },
    ],
  };
  const withHallu = labelMeasurement({ durationSec: 300, outputTokens: 40000, toolCallCount: 8, toolHallucinations: 2 }, hallu);
  assert.equal(withHallu.ranked[0].model, "Dreamy");
});

test("a class without a statistic rides the population average, not a bonus", () => {
  // Only bash evidence beyond time/tokens; "No Telemetry (Preview)" publishes
  // neither time nor tokens, so it is scored on those at the population-mean
  // LL and can only distinguish itself via its own bash rate.
  const result = labelMeasurement(
    { durationSec: 300, outputTokens: 40000, bashCount: 6, bashFailures: 0 },
    BASELINE,
    { topN: 3 },
  );
  const noTelemetry = result.ranked.find((r) => r.model === "No Telemetry (Preview)");
  const big = result.ranked.find((r) => r.model === "Big Slow (Max)");
  const tiny = result.ranked.find((r) => r.model === "Tiny Fast (Low)");
  assert.ok(noTelemetry && big && tiny);
  // Imputed values are the mean of the classes that publish the feature.
  assert.ok(Math.abs(noTelemetry.features.time - (big.features.time + tiny.features.time) / 2) < 1e-9);
  assert.ok(Math.abs(noTelemetry.features.tokens - (big.features.tokens + tiny.features.tokens) / 2) < 1e-9);
  // Its bash rate is its own, and a clean record favors it over the 15.8%-fail class.
  assert.ok(noTelemetry.features.bash > big.features.bash);
  // This measurement (5 min, 40K tokens) sits far from Tiny Fast's statistics
  // and near Big Slow's, so the ordering follows the evidence — the imputed
  // class lands where its own bash rate puts it, not last, not first.
  assert.ok(big.posterior > noTelemetry.posterior);
  assert.ok(noTelemetry.posterior > tiny.posterior);
});

test("no usable features fails loudly instead of pretending", () => {
  const result = labelMeasurement({ outputTokens: 0 }, BASELINE);
  assert.equal(result.status, "failed");
  assert.equal(result.ranked.length, 0);
  assert.ok(result.reason.includes("duration"));
});

test("independent tasks accumulate their log-likelihoods", () => {
  // Two close classes, a task sitting exactly on class A's statistics: one
  // task is a near-tie (unresolved), and repeating it accumulates the same
  // per-task evidence until the gates pass. Accumulation is the whole reason
  // a weak prior becomes usable.
  const close = {
    version: 1,
    models: [
      { name: "Tier A", signals: {}, timePerTaskMin: 5, outputTokensPerTask: 40000 },
      { name: "Tier B", signals: {}, timePerTaskMin: 7, outputTokensPerTask: 55000 },
    ],
  };
  const task = { durationSec: 5 * 60, outputTokens: 40000 };
  const one = labelMeasurement(task, close);
  assert.equal(one.status, "unresolved");
  assert.ok(one.confidence < 0.6);
  const ten = labelTasks(Array(10).fill(task), close);
  assert.equal(ten.status, "attributed");
  assert.equal(ten.model, "Tier A");
  assert.ok(ten.confidence > one.confidence);
  assert.equal(ten.tasks, 10);
  assert.equal(ten.tasksUsed, 10);
  // A task without any measurement fields does not silently count as evidence.
  const mixed = labelTasks([task, {}, task], close);
  assert.equal(mixed.tasks, 3);
  assert.equal(mixed.tasksUsed, 2);
});

test("the tasks-array input shape works end to end", () => {
  const result = labelTasks(
    [
      { turns: [{ durationSec: 48, outputTokens: 3500 }] },
      { turns: [{ durationSec: 52, outputTokens: 3800 }] },
    ],
    BASELINE,
  );
  assert.equal(result.status, "attributed");
  assert.equal(result.model, "Tiny Fast (Low)");
});

test("ambiguous measurements stay unresolved with the ranking attached", () => {
  // The geometric mean of the two classes' statistics — equidistant in the
  // log space the likelihoods live in — must come back unresolved, not as a
  // coin flip dressed as attribution.
  const result = labelMeasurement(
    { durationSec: Math.sqrt(18.1 * (50 / 60)) * 60, outputTokens: Math.round(Math.sqrt(125200 * 3900)) },
    BASELINE,
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.model, null);
  assert.ok(result.nearMiss);
  assert.ok(result.ranked.length >= 2);
  // Candidate restriction works, and two equidistant candidates tie.
  const pair = ["Big Slow (Max)", "Tiny Fast (Low)"];
  const restricted = labelMeasurement(
    { durationSec: Math.sqrt(18.1 * (50 / 60)) * 60, outputTokens: Math.round(Math.sqrt(125200 * 3900)) },
    BASELINE,
    { candidates: pair },
  );
  assert.equal(restricted.ranked.length, 2);
  assert.ok(Math.abs(restricted.ranked[0].posterior - 0.5) < 0.01);
});

test("posteriors are a normalized distribution", () => {
  // Bash calls included so even the class with N/A time/tokens carries own
  // evidence (its bash rate) and stays in the ranking.
  const allRanked = labelMeasurement(
    { durationSec: 45, outputTokens: 3600, bashCount: 2, bashFailures: 0 },
    BASELINE,
    { topN: 100 },
  );
  assert.equal(allRanked.ranked.length, 3);
  assert.ok(Math.abs(allRanked.ranked.reduce((s, r) => s + r.posterior, 0) - 1) < 1e-9);
});

test("priorStatus gates on coverage", () => {
  const ok = priorStatus(BASELINE);
  assert.equal(ok.ready, true);
  const thin = priorStatus({ models: [BASELINE.models[0]] });
  assert.equal(thin.ready, false);
  assert.ok(thin.reason);
});
