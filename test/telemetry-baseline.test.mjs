/**
 * The telemetry baseline: parsing and storage.
 *
 * The parser is the one place where the published prior can silently corrupt —
 * a mis-mapped column or a misread "50 s" poisons every attribution made from
 * it. So it is tested on the value formats the leaderboard actually emits
 * ("50 s" vs "18.1 min", "125.2K", "$4 / $20", "15.77%±0.50%", "N/A") and on
 * the structural hazards: column reordering, a dedicated Labs column, HTML
 * badges inside rank cells, and the model/lab split when the model name itself
 * contains a lab word.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePercentCell,
  parseCostCell,
  parseMinutesCell,
  parseTokensCell,
  parsePriceCell,
  parseCountCell,
  parseModelCell,
  parseMarkdownTable,
  parseHtmlTable,
  parseLeaderboard,
  parseSnapshotMeta,
  readBaseline,
  writeBaseline,
  ingestSnapshot,
  baselineSummary,
  telemetryBaselinePath,
} from "../src/fingerprint/telemetry/baseline.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arena-tel-"));

// ── cell parsers ─────────────────────────────────────────────────────────

test("percent cells keep value and CI, refuse everything else", () => {
  assert.deepEqual(parsePercentCell("20.77%±2.38%"), { value: 20.77, ci: 2.38 });
  assert.deepEqual(parsePercentCell(" 0.57%±0.13% "), { value: 0.57, ci: 0.13 });
  assert.deepEqual(parsePercentCell("18.00%±1.73%"), { value: 18, ci: 1.73 });
  assert.equal(parsePercentCell("N/A"), null);
  assert.equal(parsePercentCell("15.77"), null);
  assert.equal(parsePercentCell(""), null);
});

test("cost, minutes, tokens, price and count cells", () => {
  assert.equal(parseCostCell("$6.40"), 6.4);
  assert.equal(parseCostCell("$0.01"), 0.01);
  assert.equal(parseCostCell("N/A"), null);

  assert.equal(parseMinutesCell("18.1 min"), 18.1);
  assert.ok(Math.abs(parseMinutesCell("50 s") - 50 / 60) < 1e-12);
  assert.equal(parseMinutesCell("N/A"), null);

  assert.equal(parseTokensCell("125.2K"), 125200);
  assert.equal(parseTokensCell("3.9K"), 3900);
  assert.equal(parseTokensCell("N/A"), null);

  assert.deepEqual(parsePriceCell("$4 / $20"), { input: 4, output: 20 });
  assert.deepEqual(parsePriceCell("$0.15 / $0.60"), { input: 0.15, output: 0.6 });
  assert.equal(parsePriceCell("N/A"), null);

  assert.equal(parseCountCell("12,057"), 12057);
  assert.equal(parseCountCell("2,557,423"), 2557423);
});

test("model cell splits name, lab and license; only a trailing lab splits", () => {
  assert.deepEqual(
    parseModelCell("Claude Opus 5.5 (Max) Anthropic · Proprietary"),
    { name: "Claude Opus 5.5 (Max)", lab: "Anthropic", license: "Proprietary" },
  );
  // Model name contains a lab word, but the lab itself trails the ·.
  assert.deepEqual(
    parseModelCell("Inkling Thinky · Apache 2.0"),
    { name: "Inkling", lab: "Thinky", license: "Apache 2.0" },
  );
  // A lab word mid-name does not split the name.
  assert.deepEqual(
    parseModelCell("Beam 1.0 501B A23B Reflection · Apache 2.0"),
    { name: "Beam 1.0 501B A23B Reflection", lab: null, license: "Apache 2.0" },
  );
  assert.deepEqual(
    parseModelCell("GLM-5.2 (Max) Z.ai · MIT · SiliconFlow"),
    { name: "GLM-5.2 (Max)", lab: "Z.ai", license: "MIT · SiliconFlow" },
  );
  // No spaces around the inner ·.
  assert.deepEqual(
    parseModelCell("Kimi K3.1 Pro (Max) Moonshot · Proprietary·Preliminary"),
    { name: "Kimi K3.1 Pro (Max)", lab: "Moonshot", license: "Proprietary·Preliminary" },
  );
  // No recognizable lab: name keeps everything, nothing is invented.
  assert.deepEqual(
    parseModelCell("Some New Model V9 · MIT"),
    { name: "Some New Model V9", lab: null, license: "MIT" },
  );
});

// ── markdown table ───────────────────────────────────────────────────────

const MARKDOWN = `Some preamble text here, snapshot Oct 23, 2026, 2,557,423 sessions.

| Rank | Model | Net Improvement | Confirmed Success | Praise vs Complaint | Steerability | Bash Reliability | Tool Hallucination | Sessions | Cost/Task (P50) | Time/Task (P50) | Output Tokens/Task (P50) | Price $/M |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 11 | Claude Opus 5.5 (Max) Anthropic · Proprietary | 20.77%±2.38% | 22.08%±3.38% | 45.32%±9.27% | 17.60%±1.99% | 15.77%±0.50% | 0.57%±0.13% | 12,057 | $6.40 | 18.1 min | 125.2K | $4 / $20 |
| 41 4247 | GPT-6 Luna (Low) OpenAI · Proprietary | 4.59%±1.02% | 12.61%±2.57% | 8.69%±2.88% | 0.67%±1.37% | 1.27%±1.12% | 0.69%±0.11% | 18,454 | $0.01 | 50 s | 3.9K | N/A |
| 31 2137 | DeepSeek-V4-Pro (High, 20260813) DeepSeek · MIT | 0.27%±1.73% | 3.18%±3.91% | 0.59%±5.25% | 0.38%±2.45% | 2.37%±1.32% | 0.59%±0.13% | 7,331 | N/A | N/A | N/A | $1.32 / $3.96 |
| 37 3044 | Beam 1.0 501B A23B Reflection · Apache 2.0 | 3.04%±2.47% | 7.20%±4.83% | 2.21%±7.67% | 5.57%±3.29% | 4.45%±3.31% | 0.94%±0.75% | 12,147 | N/A | 53 s | 15.5K | $0.25 / $1 |

Trailing text.`;

test("markdown table: values, N/A and seconds land correctly", () => {
  const { models, columns } = parseMarkdownTable(MARKDOWN);
  assert.equal(models.length, 4);
  assert.ok(columns.timePerTask !== undefined);

  const opus = models[0];
  assert.equal(opus.name, "Claude Opus 5.5 (Max)");
  assert.equal(opus.lab, "Anthropic");
  assert.equal(opus.rank, 1);
  assert.equal(opus.sessions, 12057);
  assert.equal(opus.costPerTaskUsd, 6.4);
  assert.equal(opus.timePerTaskMin, 18.1);
  assert.equal(opus.outputTokensPerTask, 125200);
  assert.deepEqual(opus.price, { input: 4, output: 20 });
  assert.deepEqual(opus.signals.bashReliability, { value: 15.77, ci: 0.5 });

  const luna = models[1];
  assert.equal(luna.name, "GPT-6 Luna (Low)");
  assert.equal(luna.timePerTaskMin, 50 / 60);
  assert.equal(luna.price, null);

  const deepseek = models[2];
  // N/A stays null — a missing statistic is not a zero.
  assert.equal(deepseek.costPerTaskUsd, null);
  assert.equal(deepseek.timePerTaskMin, null);
  assert.equal(deepseek.outputTokensPerTask, null);

  const beam = models[3];
  // "A23B" sits inside the model name, not at its end — no lab is invented.
  assert.equal(beam.name, "Beam 1.0 501B A23B Reflection");
  assert.equal(beam.lab, null);
});

test("markdown table: reordered columns do not mis-assign values", () => {
  const reordered = MARKDOWN.replace(
    " | Sessions | Cost/Task (P50) | Time/Task (P50) | Output Tokens/Task (P50) | Price $/M |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n",
    " | Output Tokens/Task (P50) | Time/Task (P50) | Price $/M | Sessions | Cost/Task (P50) |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n",
  )
    .replace("| 12,057 | $6.40 | 18.1 min | 125.2K | $4 / $20 |", "| 125.2K | 18.1 min | $4 / $20 | 12,057 | $6.40 |");
  const { models } = parseMarkdownTable(reordered);
  assert.equal(models[0].timePerTaskMin, 18.1);
  assert.equal(models[0].outputTokensPerTask, 125200);
  assert.equal(models[0].costPerTaskUsd, 6.4);
});

test("snapshot metadata comes from surrounding text", () => {
  const meta = parseSnapshotMeta(MARKDOWN);
  assert.equal(meta.snapshotDate, "Oct 23, 2026");
  assert.equal(meta.sessionsTotal, 2557423);
});

// ── html table ───────────────────────────────────────────────────────────

const HTML = `<html><body><main>
<table><thead><tr>
  <th>Rank</th><th>Model</th><th>Labs</th><th>Bash Reliability</th><th>Tool Hallucination</th><th>Sessions</th><th>Cost/Task (P50)</th><th>Time/Task (P50)</th><th>Output Tokens/Task (P50)</th>
</tr></thead><tbody>
<tr><td><span>3</span><span>Δ7</span></td><td><div>GPT-6 Astra (Max)</div></td><td>OpenAI · Proprietary</td><td>9.29%&plusmn;1.29%</td><td>0.71%±0.08%</td><td>14,567</td><td>$4.66</td><td>10.8 min</td><td>34.4K</td></tr>
<tr><td>20</td><td><div>GPT-6 Luna (Max) &amp; friends</div></td><td>OpenAI · Proprietary</td><td>10.69%±0.28%</td><td>0.61%±0.07%</td><td>194,437</td><td>$0.09</td><td>6.5 min</td><td>42.1K</td></tr>
</tbody></table>
</main></body></html>`;

test("html table: badges, block boundaries and entities", () => {
  const { models } = parseHtmlTable(HTML);
  assert.equal(models.length, 2);
  assert.equal(models[0].name, "GPT-6 Astra (Max)");
  assert.equal(models[0].rank, 3);
  assert.equal(models[0].lab, "OpenAI");
  assert.deepEqual(models[0].signals.bashReliability, { value: 9.29, ci: 1.29 });
  assert.equal(models[0].sessions, 14567);
  assert.equal(models[0].outputTokensPerTask, 34400);
  // &amp; decoded, not left as markup noise.
  assert.equal(models[1].name, "GPT-6 Luna (Max) & friends");
  assert.equal(models[1].rank, 20);
});

test("parseLeaderboard auto-detects the format", () => {
  assert.equal(parseLeaderboard(HTML).source, "html");
  assert.equal(parseLeaderboard(MARKDOWN).source, "markdown");
  assert.equal(parseLeaderboard("no table here").models.length, 0);
});

// ── store ────────────────────────────────────────────────────────────────

test("baseline store round-trips and reads missing as empty", () => {
  const dir = tmpDir();
  assert.equal(readBaseline(dir).models.length, 0);
  const parsed = parseMarkdownTable(MARKDOWN).models;
  writeBaseline(dir, { models: parsed });
  const back = readBaseline(dir);
  assert.equal(back.version, 1);
  assert.equal(back.models.length, 4);
  assert.equal(readBaseline(dir, { strict: true }).models.length, 4);
  fs.writeFileSync(telemetryBaselinePath(dir), "{not json");
  assert.equal(readBaseline(dir).models.length, 0); // tolerant read
  assert.throws(() => readBaseline(dir, { strict: true }));
});

test("ingestSnapshot stores baseline plus raw snapshot, refuses empty parses", () => {
  const dir = tmpDir();
  const ok = ingestSnapshot(dir, MARKDOWN, { source: "test" });
  assert.equal(ok.stored, true);
  assert.equal(ok.models, 4);
  assert.equal(readBaseline(dir).source, "test");
  assert.ok(fs.existsSync(path.join(dir, "telemetry-snapshot.txt")));
  const bad = ingestSnapshot(tmpDir(), "nothing parseable");
  assert.equal(bad.stored, false);
  assert.ok(bad.reason);
});

test("baselineSummary reports feature coverage", () => {
  const dir = tmpDir();
  ingestSnapshot(dir, MARKDOWN);
  const summary = baselineSummary(readBaseline(dir));
  assert.equal(summary.models, 4);
  assert.equal(summary.withTime, 3); // DeepSeek-V4-Pro is N/A
  assert.equal(summary.withTokens, 3);
  assert.equal(summary.withBash, 4);
  assert.equal(summary.withToolHallucination, 4);
});
