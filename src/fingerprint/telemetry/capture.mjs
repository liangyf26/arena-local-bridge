/**
 * fingerprint/telemetry/capture.mjs — passive per-task telemetry from the bridge
 *
 * The labeler (identify.mjs) eats task-level measurements; this file is where
 * they come from. Every completion the bridge produces is one turn of evidence
 * — durations, output tokens, tool calls — observed in passing, with no extra
 * Arena traffic and no probe cost. Turns chain into TASKS, because the
 * published statistics the prior discriminates on are per task:
 *
 *   converse (toolPolicy=allow) — Arena runs its whole task inside one call,
 *     so one call flushes one task record.
 *   runAgent (client-delegated tools) — the task spans requests: a completion
 *     carrying tool_calls continues the task, and the next request's
 *     `role:"tool"` results (or a fresh user message) close or cut it.
 *
 * Records append to `telemetry-tasks.jsonl`, one JSON object per line, shaped
 * exactly like the labeler's per-task input. Failure of any kind here must
 * never take a turn down: recordTurn swallows its own errors.
 */
import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./identify.mjs";

export const TASKS_FILE = "telemetry-tasks.jsonl";

/**
 * Tools whose execution is shell-like. Deliberately broad — "executor" IS an
 * execution tool — because a missed bash call costs a feature, and a false
 * bash call only dilutes it.
 */
export const BASH_TOOL_RE = /(bash|zsh|powershell|(^|[^a-z])sh([^a-z]|$)|shell|terminal|console|exec|command|cmd)/i;

/**
 * A shell result that reads as a command failure. Kept conservative: a normal
 * command's output may legitimately contain the word "error", but exit codes,
 * tracebacks and shell-level complaints are unambiguous.
 */
export function shellFailureText(content) {
  const text = String(content ?? "").slice(0, 4000);
  return /exit (code|status)\s*[:=]?\s*[1-9]|non-?zero exit|command not found|no such file|permission denied|traceback \(most recent|syntax error near unexpected|is not recognized as an internal or external command/i.test(text);
}

/** Tool names the client actually advertised (OpenAI `tools[].function.name`). */
function advertisedNames(body) {
  return new Set(
    (Array.isArray(body?.tools) ? body.tools : [])
      .map((t) => String(t?.function?.name || t?.name || "").trim())
      .filter(Boolean)
  );
}

/** One OpenAI-style tool call of a completion message. */
function payloadToolCalls(payload) {
  return (Array.isArray(payload?.choices?.[0]?.message?.tool_calls) ? payload.choices[0].message.tool_calls : [])
    .filter((c) => c && typeof c === "object");
}

/** Tool results the client sent back, as { id, content } pairs. */
function payloadToolResults(body) {
  const out = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== "tool") continue;
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    out.push({ id: String(m.tool_call_id || ""), content });
  }
  return out;
}

function blankTask() {
  return {
    at: new Date().toISOString(),
    turns: 0,
    durationSec: 0,
    outputTokens: 0,
    bashCount: 0,
    bashFailures: 0,
    toolCallCount: 0,
    toolHallucinations: 0,
    nativeToolCalls: 0,
    bashIds: new Set(),
  };
}

export class TelemetryCapture {
  constructor({ dataDir, enabled = true } = {}) {
    this.dataDir = dataDir || "";
    this.enabled = Boolean(enabled && dataDir);
    this.pending = new Map();
  }

  tasksPath() {
    return path.join(this.dataDir, TASKS_FILE);
  }

  pendingCount() {
    return this.pending.size;
  }

  /**
   * Record one completed bridge turn and flush a task record when the task is
   * done. Never throws — a telemetry failure must not cost a completion.
   */
  recordTurn(input) {
    if (!this.enabled) return null;
    try {
      const { chainKey, kind = "", body = {}, payload = null, nativeCalls = [], outputText = "", durationSec = 0, at } = input || {};
      if (!chainKey) return null;
      return this.#record(chainKey, kind, body, payload, nativeCalls, outputText, durationSec, at);
    } catch (error) {
      try {
        console.warn(`[telemetry] capture failed (turn ignored): ${error?.message || error}`);
      } catch {
        /* logging is best-effort too */
      }
      return null;
    }
  }

  #record(chainKey, kind, body, payload, nativeCalls, outputText, durationSec, at) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    // A task continues only when this request carries tool RESULTS. Anything
    // else — a fresh user message, a session the client restarted — starts one.
    const continues = messages.length > 0 && messages[messages.length - 1]?.role === "tool";
    let task = this.pending.get(chainKey);
    if (task && !continues) this.#flushTask(chainKey, { ...task, truncated: true });
    if (!task || !continues) {
      task = blankTask();
      task.kind = kind;
      if (at) task.at = at;
      this.pending.set(chainKey, task);
    }

    task.turns += 1;
    task.durationSec += Math.max(0, Number(durationSec) || 0);
    task.outputTokens += estimateTokens(outputText);

    // Tool calls handed to the CLIENT (runAgent delegate path). A call for a
    // tool the client never advertised is the hallucination the leaderboard
    // counts; a bash-like one is shell evidence pending its result.
    const advertised = advertisedNames(body);
    for (const call of payloadToolCalls(payload)) {
      const fn = call.function || call;
      const name = String(fn.name || call.name || "").trim();
      if (!name) continue;
      task.toolCallCount += 1;
      if (advertised.size > 0 && !advertised.has(name)) task.toolHallucinations += 1;
      if (BASH_TOOL_RE.test(name)) {
        task.bashCount += 1;
        const id = String(call.id || fn.id || "");
        if (id) task.bashIds.add(id);
      }
      task.outputTokens += estimateTokens(String(fn.arguments || ""));
    }

    // Tool calls Arena ran ITSELF (toolPolicy=allow). They arrive as native
    // events and never reach the client, so they are counted here and their
    // input-parse failures count as shell failures directly.
    for (const call of Array.isArray(nativeCalls) ? nativeCalls : []) {
      const name = String(call?.name || "").trim();
      if (!name) continue;
      task.nativeToolCalls += 1;
      task.toolCallCount += 1;
      if (BASH_TOOL_RE.test(name)) {
        task.bashCount += 1;
        if (call.errored) task.bashFailures += 1;
      }
      task.outputTokens += estimateTokens(String(call?.rawInput || ""));
    }

    // Shell results coming back from the CLIENT for the bash calls this task
    // issued. Results for unknown ids are ignored — they belong to a task we
    // did not see start.
    for (const result of payloadToolResults(body)) {
      if (!result.id || !task.bashIds.has(result.id)) continue;
      if (shellFailureText(result.content)) task.bashFailures += 1;
      task.bashIds.delete(result.id);
    }

    // Task done? Arena reached its final answer with nothing left to execute.
    const delegatedPending = payloadToolCalls(payload).length > 0;
    if (kind === "converse" || !delegatedPending) {
      this.#flushTask(chainKey, { ...task });
      this.pending.delete(chainKey);
    }
    return null;
  }

  /**
   * Write a task record unless it carries no evidence at all — a degenerate
   * turn (no duration, no tokens, no tool events) is noise in the JSONL, and
   * the labeler would skip it anyway.
   */
  #flushTask(chainKey, record) {
    const hasEvidence =
      Number(record.durationSec) > 0 || Number(record.outputTokens) > 0 || Number(record.toolCallCount) > 0;
    if (!hasEvidence) return;
    this.#flush(chainKey, { ...record, bashIds: undefined });
  }

  /** Append one task record. Called only from #record / #flushTask. */
  #flush(chainKey, record) {
    const line = JSON.stringify({ chainKey, ...record });
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.appendFileSync(this.tasksPath(), `${line}\n`, "utf8");
  }

  /** Flush in-flight tasks as truncated (shutdown, or a task that died). */
  flushAll() {
    if (!this.enabled) return 0;
    let n = 0;
    for (const [chainKey, task] of this.pending) {
      this.#flushTask(chainKey, { ...task, truncated: true });
      n += 1;
    }
    this.pending.clear();
    return n;
  }
}

/** Read task records back for the labeler. Tolerates a torn last line. */
export function readTaskRecords(dataDir, { chain, file } = {}) {
  const tasksPath = file || path.join(dataDir, TASKS_FILE);
  let text = "";
  try {
    text = fs.readFileSync(tasksPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (chain && !String(rec.chainKey || "").includes(chain)) continue;
      records.push(rec);
    } catch {
      /* a torn final line is normal after a crash mid-append */
    }
  }
  return records;
}
