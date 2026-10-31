/**
 * fingerprint/telemetry/baseline.mjs — the published-telemetry prior
 *
 * Arena's agent leaderboard publishes, per model, five signals plus three P50
 * task statistics (Cost/Task, Time/Task, Output Tokens/Task). Those numbers are
 * the prior this directory's labeler discriminates on — the one data source
 * that covers all ~55 candidate classes without spending a single probe turn.
 *
 * This file turns a leaderboard snapshot (rendered HTML, or the markdown a
 * reader tool emits from it) into that baseline, and keeps it in
 * `telemetry-baseline.json` next to the fingerprint bank. Parsing is pure and
 * column-driven: headers are located by name, so Arena reordering or inserting
 * columns does not silently mis-assign values.
 *
 * A published "N/A" is kept as null, never as zero — a missing statistic is a
 * feature the labeler must skip for that model, and zero would read as a
 * measurement instead.
 */
import fs from "node:fs";
import path from "node:path";

/** Bumped when the baseline record shape changes. */
export const BASELINE_VERSION = 1;

export function telemetryBaselinePath(dataDir) {
  return path.join(dataDir, "telemetry-baseline.json");
}

/** Labs seen in the leaderboard's model cell. Matched last-occurrence-first. */
const LABS = [
  "Anthropic", "OpenAI", "Google", "Meta", "Moonshot", "DeepSeek", "Xiaomi",
  "Tencent", "Z.ai", "Alibaba", "SpaceXAI", "StepFun", "MiniMax", "A23B",
  "Mistral", "Thinky", "Upstage", "Nvidia", "Zhipu", "Baidu", "01.AI",
];
const LAB_RE = new RegExp(`\\b(${LABS.map((l) => l.replace(".", "\\.").replace("+", "\\+")).join("|")})\\b`, "gi");

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

/* ------------------------------------------------------------------ cells */

/** "20.77%±2.38%" → { value: 20.77, ci: 2.38 }; anything else → null. */
export function parsePercentCell(raw) {
  const m = /^\s*(-?[\d.]+)\s*%\s*±\s*(-?[\d.]+)\s*%\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  return { value: Number(m[1]), ci: Number(m[2]) };
}

/** "$6.40" → 6.4; "N/A" → null. */
export function parseCostCell(raw) {
  const m = /^\s*\$\s*(-?[\d.]+)\s*$/.exec(String(raw ?? ""));
  return m ? Number(m[1]) : null;
}

/** "18.1 min" → 18.1; "50 s" → 0.8333 (minutes). */
export function parseMinutesCell(raw) {
  const m = /^\s*([\d.]+)\s*(min(?:ute)?s?|s|sec(?:onds)?)?\s*$/i.exec(String(raw ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /^s/i.test(m[2] ?? "") ? n / 60 : n;
}

/** "125.2K" → 125200. */
export function parseTokensCell(raw) {
  const m = /^\s*([\d.]+)\s*([KkMm]?)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale = m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1;
  return n * scale;
}

/** "$4 / $20" → { input: 4, output: 20 }. */
export function parsePriceCell(raw) {
  const m = /^\s*\$\s*([\d.]+)\s*\/\s*\$\s*([\d.]+)\s*$/.exec(String(raw ?? ""));
  return m ? { input: Number(m[1]), output: Number(m[2]) } : null;
}

/** "12,057" → 12057. */
export function parseCountCell(raw) {
  const m = /^\s*([\d,]+)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * "Claude Opus 5.5 (Max) Anthropic · Proprietary" →
 * { name: "Claude Opus 5.5 (Max)", lab: "Anthropic", license: "Proprietary" }.
 *
 * The lab, when the cell carries one, is the trailing word before the ·. So a
 * lab word inside the name ("Inkling Thinky", "Beam 1.0 501B A23B Reflection")
 * never splits the name — only a match with nothing after it counts. No such
 * match → the whole pre-· text stays in `name` and `lab` is null;
 * identification keys on the full name, so a missed lab degrades metadata,
 * never the class.
 */
export function parseModelCell(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  const parts = text.split("·");
  const nameLab = (parts[0] || "").trim();
  const license = parts.slice(1).join("·").trim() || null;
  let lab = null;
  let name = nameLab;
  const matches = [...nameLab.matchAll(LAB_RE)];
  if (matches.length) {
    const last = matches[matches.length - 1];
    if (!nameLab.slice(last.index + last[0].length).trim()) {
      lab = last[1];
      name = nameLab.slice(0, last.index).trim();
    }
  }
  return { name, lab, license };
}

/* ----------------------------------------------------------------- tables */

const SIGNAL_KEYS = ["netImprovement", "confirmedSuccess", "praiseVsComplaint", "steerability", "bashReliability", "toolHallucination"];

/** Header cell → canonical column key, or null for an unknown column. */
function headerKey(raw) {
  const norm = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm) return null;
  if (norm === "rank") return "rank";
  if (norm === "model" || norm === "models") return "model";
  if (norm.startsWith("lab")) return "lab";
  if (norm.startsWith("netimprovement")) return "netImprovement";
  if (norm.startsWith("confirmedsuccess")) return "confirmedSuccess";
  if (norm.startsWith("praise")) return "praiseVsComplaint";
  if (norm.startsWith("steer")) return "steerability";
  if (norm.startsWith("bashreliability")) return "bashReliability";
  if (norm.startsWith("toolhallucination")) return "toolHallucination";
  if (norm.startsWith("session")) return "sessions";
  if (norm.startsWith("cost")) return "costPerTask";
  if (norm.startsWith("time")) return "timePerTask";
  if (norm.startsWith("outputtokens")) return "outputTokens";
  if (norm.startsWith("price")) return "price";
  return null;
}

function buildRecord(cells, cols) {
  const at = (key) => (cols[key] === undefined ? null : String(cells[cols[key]] ?? ""));
  const modelCell = at("model") ?? "";
  const labCell = at("lab") ?? null;
  const rankText = at("rank") ?? "";
  const derived = parseModelCell(modelCell);
  let { name, lab, license } = derived;
  // A dedicated Labs column wins over the combined-cell heuristic.
  if (labCell && labCell.trim()) {
    const fromColumn = parseModelCell(`${name} ${labCell.trim()}`);
    lab = fromColumn.lab;
    license = fromColumn.license ?? license;
  }
  const signals = {};
  for (const key of SIGNAL_KEYS) signals[key] = parsePercentCell(at(key));
  const record = {
    name,
    rank: Number.isFinite(Number(String(rankText).trim().split(/\s+/)[0])) ? Number(String(rankText).trim().split(/\s+/)[0]) : null,
    lab,
    license,
    signals,
    sessions: parseCountCell(at("sessions")),
    costPerTaskUsd: parseCostCell(at("costPerTask")),
    timePerTaskMin: parseMinutesCell(at("timePerTask")),
    outputTokensPerTask: parseTokensCell(at("outputTokens")),
    price: parsePriceCell(at("price")),
  };
  return record.name ? record : null;
}

/** Snapshot date ("Oct 23, 2026") and session total from surrounding text. */
export function parseSnapshotMeta(text) {
  const date = new RegExp(`(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2},\\s*\\d{4}`, "i").exec(String(text ?? ""));
  const sessions = /([\d,]{4,})\s+sessions/i.exec(String(text ?? ""));
  return {
    snapshotDate: date ? date[0] : null,
    sessionsTotal: sessions ? Number(sessions[1].replace(/,/g, "")) : null,
  };
}

/** One markdown pipe-table row → cells (separator rows come back as null). */
function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
  if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) return null;
  return cells;
}

/** Parse a markdown leaderboard table (e.g. a reader tool's rendering). */
export function parseMarkdownTable(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let cols = null;
  const models = [];
  for (const line of lines) {
    const cells = splitMarkdownRow(line);
    if (!cells || cells.length < 10) continue;
    if (!cols) {
      const mapped = cells.map(headerKey);
      if (mapped[1] === "model") {
        cols = {};
        mapped.forEach((k, i) => { if (k && cols[k] === undefined) cols[k] = i; });
      }
      continue;
    }
    const record = buildRecord(cells, cols);
    if (record) models.push(record);
  }
  return { models, columns: cols };
}

/** Strip tags from an HTML fragment, keeping block boundaries as spaces. */
function stripHtml(fragment) {
  return String(fragment ?? "")
    .replace(/<[^>]*>/g, (tag) => (/^<\/?(div|p|li|tr|h[1-6]|section|span)\b/i.test(tag) ? " " : ""))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&plusmn;/gi, "±")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse the rendered leaderboard <table> out of a page's HTML. */
export function parseHtmlTable(html) {
  const text = String(html ?? "");
  const tableMatch = text.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return { models: [], columns: null };
  const cols = {};
  let colsReady = false;
  const models = [];
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((m) => stripHtml(m[2]));
    if (!cells.length) continue;
    if (!colsReady) {
      const mapped = cells.map(headerKey);
      const modelIdx = mapped.indexOf("model");
      if (modelIdx >= 0) {
        mapped.forEach((k, i) => { if (k && cols[k] === undefined) cols[k] = i; });
        colsReady = true;
      }
      continue;
    }
    const record = buildRecord(cells, cols);
    if (record) models.push(record);
  }
  return { models, columns: colsReady ? cols : null };
}

/** Auto-detect format and parse. Returns { models, columns, source }. */
export function parseLeaderboard(text) {
  const s = String(text ?? "");
  const parsed = /<table[\s\S]*<\/table>/i.test(s) ? parseHtmlTable(s) : parseMarkdownTable(s);
  return { ...parsed, source: /<table/i.test(s) ? "html" : "markdown" };
}

/* ------------------------------------------------------------------ store */

/** A missing file reads as empty — the baseline is refetchable derived data. */
export function readBaseline(dataDir, { strict = false } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(telemetryBaselinePath(dataDir), "utf8"));
    if (parsed?.version === BASELINE_VERSION && Array.isArray(parsed.models)) return parsed;
    if (strict) throw new Error("Unsupported telemetry baseline version or shape");
  } catch (error) {
    if (strict && error.code !== "ENOENT") throw error;
  }
  return { version: BASELINE_VERSION, fetchedAt: null, source: null, snapshotDate: null, sessionsTotal: null, models: [] };
}

export function writeBaseline(dataDir, baseline) {
  const file = telemetryBaselinePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...baseline, version: BASELINE_VERSION }), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Persist a parsed snapshot. `raw` (the untouched page/markdown) is kept beside
 * the baseline so a parser fix can re-derive records without refetching.
 */
export function ingestSnapshot(dataDir, text, { source } = {}) {
  const { models, columns, source: detected } = parseLeaderboard(text);
  if (!models.length) {
    return { stored: false, reason: "no model rows parsed from the snapshot", models: [] };
  }
  const meta = parseSnapshotMeta(text);
  writeBaseline(dataDir, {
    version: BASELINE_VERSION,
    fetchedAt: new Date().toISOString(),
    source: source ?? detected,
    snapshotDate: meta.snapshotDate,
    sessionsTotal: meta.sessionsTotal,
    modelCount: models.length,
    models,
  });
  const rawPath = path.join(dataDir, "telemetry-snapshot.txt");
  fs.writeFileSync(rawPath, text, "utf8");
  return { stored: true, reason: null, models: models.length, snapshotDate: meta.snapshotDate, rawPath };
}

/** What the baseline covers — the labeler's warnings read off this. */
export function baselineSummary(baseline) {
  const models = baseline?.models ?? [];
  const withFeature = (pred) => models.filter(pred).length;
  return {
    models: models.length,
    snapshotDate: baseline?.snapshotDate ?? null,
    fetchedAt: baseline?.fetchedAt ?? null,
    withTime: withFeature((m) => m.timePerTaskMin != null),
    withTokens: withFeature((m) => m.outputTokensPerTask != null),
    withBash: withFeature((m) => m.signals?.bashReliability != null),
    withToolHallucination: withFeature((m) => m.signals?.toolHallucination != null),
  };
}
