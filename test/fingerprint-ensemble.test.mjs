/**
 * The ensemble: alignment, fusion and the agreement gate.
 *
 * The math is tested on the properties that make the fusion honest: a
 * signal's votes renormalize onto the canonical space, abstention (a class
 * outside a signal's support) is scored at the signal's mean and therefore
 * neutral, and weights move the verdict only as far as they should. The gate
 * is tested on its reason for existing: one signal must never carry a label,
 * two agreeing signals must, and disagreement is surfaced, not hidden.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeName,
  alignName,
  fuseVotes,
  telemetryVoteFromTasks,
  appendVote,
  readVotes,
  votesPath,
} from "../src/fingerprint/ensemble.mjs";
import { TASKS_FILE } from "../src/fingerprint/telemetry/capture.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arena-ens-"));

// ── alignment ────────────────────────────────────────────────────────────

const CANON = ["GPT-6 Luna (Low)", "GPT-6 Luna (Max)", "Claude Opus 5.5 (Max)", "GLM-5.3-Flash"];

test("alignment: exact normalized, alias, unique containment", () => {
  assert.equal(alignName("gpt-6 luna (low)", CANON), "GPT-6 Luna (Low)");
  assert.equal(alignName("GPT_6__LUNA_LOW!!", CANON), "GPT-6 Luna (Low)");
  assert.equal(
    alignName("catalog:glm-5.3-flash", CANON, { "catalog:glm-5.3-flash": "GLM-5.3-Flash" }),
    "GLM-5.3-Flash",
  );
  // Unique containment resolves tier-less or decorated names.
  assert.equal(alignName("claude opus 5.5 max tier", CANON), "Claude Opus 5.5 (Max)");
  // Ambiguous containment must NOT guess: a tier-less Luna sits inside two classes.
  assert.equal(alignName("gpt-6 luna", CANON), null);
  assert.equal(alignName("some model that never shipped", CANON), null);
  assert.equal(alignName("", CANON), null);
});

// ── fusion math ──────────────────────────────────────────────────────────

test("two agreeing signals fuse into an attributed verdict", () => {
  const a = { signal: "telemetry", votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.8 }, { model: "GPT-6 Luna (Max)", posterior: 0.15 }, { model: "GLM-5.3-Flash", posterior: 0.05 }] };
  const b = { signal: "numeric", votes: [{ model: "gpt-6-luna-low", posterior: 0.75 }, { model: "gpt-6-luna-max", posterior: 0.2 }, { model: "glm-5.3-flash", posterior: 0.05 }] };
  const result = fuseVotes([a, b], CANON);
  assert.equal(result.status, "attributed");
  assert.equal(result.model, "GPT-6 Luna (Low)");
  assert.ok(result.confidence > 0.9);
  assert.ok(result.margin > 1.0);
  assert.deepEqual(result.agreement.agreeing, ["telemetry", "numeric"]);
});

test("one signal alone can never carry a label", () => {
  const a = { signal: "telemetry", votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.99 }, { model: "GPT-6 Luna (Max)", posterior: 0.01 }] };
  const result = fuseVotes([a], CANON);
  assert.equal(result.status, "unresolved");
  assert.equal(result.model, null);
  assert.ok(result.reason.includes("agreement gate needs 2"));
  assert.ok(result.ranked.length >= 1); // the ranking is still reported
  // The opt-in escape hatch is explicit, not accidental.
  const relaxed = fuseVotes([a], CANON, { minAgree: 1 });
  assert.equal(relaxed.status, "attributed");
  assert.equal(relaxed.model, "GPT-6 Luna (Low)");
});

test("a repeated signal vote replaces the earlier one instead of inflating agreement", () => {
  // Two numeric votes (a re-run probe) agreeing with each other, telemetry
  // disagreeing: counting numeric twice would fake a 2/3 agreement. The later
  // vote must REPLACE the earlier one — and win against the stale one.
  const telemetry = { signal: "telemetry", weight: 1, votes: [{ model: "GLM-5.3-Flash", posterior: 0.9 }, { model: "GPT-6 Luna (Low)", posterior: 0.1 }] };
  const numericOld = { signal: "numeric", weight: 1, votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.95 }, { model: "GLM-5.3-Flash", posterior: 0.05 }] };
  const numericNew = { signal: "numeric", weight: 1, votes: [{ model: "GLM-5.3-Flash", posterior: 0.9 }, { model: "GPT-6 Luna (Low)", posterior: 0.1 }] };
  const result = fuseVotes([telemetry, numericOld, numericNew], CANON, { minAgree: 1 });
  assert.equal(result.signals.length, 2); // numeric appears once
  assert.ok(result.notes.some((n) => n.includes("numeric") && n.includes("replaced")));
  // With the OLD vote counted, numeric+telemetry would have disagreed;
  // with the NEW vote, both agree on GLM — attributed, not unresolved.
  assert.equal(result.status, "attributed");
  assert.equal(result.model, "GLM-5.3-Flash");
  assert.deepEqual(result.agreement.agreeing, ["telemetry", "numeric"]);
});

test("disagreement blocks attribution and is surfaced", () => {
  // Explicit unit weights: the point is the disagreement logic, not the
  // reliability dial (numeric defaults to weight 2, which would tilt the fusion).
  const a = { signal: "telemetry", weight: 1, votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.8 }, { model: "GPT-6 Luna (Max)", posterior: 0.15 }, { model: "GLM-5.3-Flash", posterior: 0.05 }] };
  const b = { signal: "numeric", weight: 1, votes: [{ model: "GLM-5.3-Flash", posterior: 0.8 }, { model: "GPT-6 Luna (Low)", posterior: 0.1 }, { model: "GPT-6 Luna (Max)", posterior: 0.1 }] };
  const result = fuseVotes([a, b], CANON);
  assert.equal(result.status, "unresolved");
  assert.ok(result.reason.includes("agreed by 1/2"));
  assert.deepEqual(result.agreement.disagreeing, [{ signal: "numeric", top: "GLM-5.3-Flash" }]);
});

test("weights pull the fused verdict with their configured strength", () => {
  const a = { signal: "telemetry", votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.6 }, { model: "GPT-6 Luna (Max)", posterior: 0.4 }] };
  const b = { signal: "numeric", votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.4 }, { model: "GPT-6 Luna (Max)", posterior: 0.6 }] };
  // A weight replicates a signal's evidence w times in the log pool — it is
  // NOT a softmax invariant, so it genuinely sharpens the pull. The two
  // signals disagree here, so the agreement gate must still be relaxed for
  // the dial itself to be observable.
  const flipped = fuseVotes([a, b], CANON, { minAgree: 1, weights: { telemetry: 1, numeric: 5 } });
  assert.equal(flipped.model, "GPT-6 Luna (Max)");
  const back = fuseVotes([a, b], CANON, { minAgree: 1, weights: { telemetry: 5, numeric: 1 } });
  assert.equal(back.model, "GPT-6 Luna (Low)");
});

test("abstention is scored at the signal's mean — neither advantage nor veto", () => {
  const seesAll = { signal: "telemetry", weight: 1, votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.5 }, { model: "GPT-6 Luna (Max)", posterior: 0.3 }, { model: "GLM-5.3-Flash", posterior: 0.2 }] };
  const seesTwo = { signal: "numeric", weight: 1, votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.5 }, { model: "GPT-6 Luna (Max)", posterior: 0.5 }] };
  const result = fuseVotes([seesAll, seesTwo], CANON, { minAgree: 1 });
  const byName = Object.fromEntries(result.ranked.map((r) => [r.model, r]));
  // GLM is invisible to numeric, so its fused score = telemetry's ln(0.2)
  // plus numeric's mean log-vote — exactly the neutral imputation.
  const numericMean = (Math.log(0.5) + Math.log(0.5)) / 2;
  const expectedGlm = Math.log(0.2) + numericMean;
  assert.ok(Math.abs(byName["GLM-5.3-Flash"].logLik - expectedGlm) < 1e-9);
  assert.equal(byName["GLM-5.3-Flash"].seenBy, 1);
  // And a class NO signal sees does not appear in the ranking at all.
  const noGhost = fuseVotes([seesAll, seesTwo], ["GPT-6 Luna (Low)", "GPT-6 Luna (Max)", "GLM-5.3-Flash", "Solar Pro 4"], { minAgree: 1 });
  assert.ok(!noGhost.ranked.some((r) => r.model === "Solar Pro 4"));
});

test("unaligned votes are dropped with a note, posteriors renormalize", () => {
  const a = { signal: "numeric", weight: 1, votes: [{ model: "Mystery Model 9000", posterior: 0.9 }, { model: "GPT-6 Luna (Low)", posterior: 0.8 }, { model: "GPT-6 Luna (Max)", posterior: 0.4 }] };
  const result = fuseVotes([a], CANON);
  assert.ok(result.notes.some((n) => n.includes("1 vote(s) matched no canonical class")));
  // 0.8 vs 0.4 renormalized to 2/3 vs 1/3 — the dropped 0.9 must not distort.
  const low = result.ranked.find((r) => r.model === "GPT-6 Luna (Low)");
  const max = result.ranked.find((r) => r.model === "GPT-6 Luna (Max)");
  assert.ok(Math.abs(low.posterior - max.posterior * 2) < 1e-9);
});

test("no aligned votes at all fails loudly", () => {
  const ghost = { signal: "numeric", votes: [{ model: "Mystery Model 9000", posterior: 1 }] };
  assert.equal(fuseVotes([ghost], CANON).status, "failed");
  assert.equal(fuseVotes([], CANON).status, "failed");
  assert.equal(fuseVotes([ghost], []).status, "failed");
});

// ── telemetry adapter ────────────────────────────────────────────────────

const BASELINE = {
  version: 1,
  models: [
    { name: "Tiny Fast (Low)", lab: "OpenAI", signals: { bashReliability: { value: 1.27, ci: 1.12 } }, timePerTaskMin: 50 / 60, outputTokensPerTask: 3900 },
    { name: "Big Slow (Max)", lab: "Anthropic", signals: { bashReliability: { value: 15.77, ci: 0.5 } }, timePerTaskMin: 18.1, outputTokensPerTask: 125200 },
  ],
};

test("telemetry vote derives from captured task records", () => {
  const dir = tmpDir();
  const records = [
    { chainKey: "s1", kind: "converse", turns: 1, durationSec: 50, outputTokens: 4000, bashCount: 2, bashFailures: 0, toolCallCount: 4, nativeToolCalls: 4 },
    { chainKey: "s1", kind: "converse", turns: 1, durationSec: 55, outputTokens: 3800, bashCount: 3, bashFailures: 0, toolCallCount: 5, nativeToolCalls: 5 },
    { chainKey: "other", kind: "converse", turns: 1, durationSec: 1000, outputTokens: 90000, bashCount: 1, bashFailures: 0, toolCallCount: 2, nativeToolCalls: 2 },
  ];
  fs.writeFileSync(path.join(dir, TASKS_FILE), records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  const vote = telemetryVoteFromTasks(dir, "s1", BASELINE);
  assert.ok(vote);
  assert.equal(vote.signal, "telemetry");
  assert.ok(vote.votes.length >= 1);
  assert.ok(Math.abs(vote.votes.reduce((s, v) => s + v.posterior, 0) - 1) < 1e-6);
  assert.equal(vote.votes[0].model, "Tiny Fast (Low)"); // two fast light tasks
  // Another session's records must not leak in.
  assert.equal(telemetryVoteFromTasks(dir, "nosuch", BASELINE), null);
});

// ── vote store ───────────────────────────────────────────────────────────

test("stored votes round-trip, filter by session, survive a torn line", () => {
  const dir = tmpDir();
  appendVote(dir, { sessionId: "s1", signal: "numeric", votes: [{ model: "GPT-6 Luna (Low)", posterior: 0.9 }], notes: ["bank=2"] });
  appendVote(dir, { sessionId: "s2", signal: "llmmap", votes: [{ model: "GLM-5.3-Flash", posterior: 0.6 }], weight: 0.5 });
  assert.equal(readVotes(dir).length, 2);
  assert.equal(readVotes(dir, { sessionId: "s1" }).length, 1);
  assert.equal(readVotes(dir, { sessionId: "s1" })[0].signal, "numeric");
  assert.equal(readVotes(dir, { sessionId: "s2" })[0].weight, 0.5);
  fs.appendFileSync(votesPath(dir), '{"sessionId":"s1","sig', "utf8");
  assert.equal(readVotes(dir).length, 2); // torn line skipped
  // Malformed appends are refused, not half-written.
  assert.throws(() => appendVote(dir, { sessionId: "s1", signal: "numeric" }));
});
