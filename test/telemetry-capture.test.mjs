/**
 * The passive telemetry capture.
 *
 * The capture sits inside the bridge's turn path, so it is tested on the two
 * ways it could do damage or lie: it must never throw into a turn (a telemetry
 * failure may not cost a completion), and its task records must be exactly the
 * labeler's input shape. The task semantics tested here are the ones the
 * published statistics live at — a task spans delegated tool calls and closes
 * on the final answer, and a fresh user message cuts a dangling task loose
 * rather than merging two tasks into one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryCapture, readTaskRecords, shellFailureText, BASH_TOOL_RE, TASKS_FILE } from "../src/fingerprint/telemetry/capture.mjs";
import { Bridge } from "../src/bridge.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arena-telcap-"));

const completion = (content, toolCalls = null) => ({
  choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
});

/** A real Bridge whose page half is mocked — converse() costs no browser. */
function makeBridge({ telemetryCapture = true } = {}) {
  const dataDir = tmpDir();
  const config = {
    dataDir,
    telemetryCapture,
    mcpEndpointFile: path.join(dataDir, "mcp-endpoint.json"),
    codexSessionsDir: path.join(dataDir, "no-codex-here"),
    codexRecentWindowMs: 0,
    mcpWorkspace: "",
    host: "127.0.0.1",
    port: 0,
    bridgeKey: "k",
    maxQueue: 8,
    maxToolCalls: 8,
    turnMarkerEnabled: false,
    resultCacheTtlMs: 60_000,
    readBudgetMs: 0,
    readRetryMax: 0,
    readRetryDelayMs: 0,
    // allow + no follow-up budget: the turn returns through the FINAL answer
    // path, which is the one telemetry records.
    toolPolicy: "allow",
    toolAllowBudgetMs: 0,
    toolAllowMaxReads: 0,
  };
  const bridge = new Bridge({
    config,
    credentials: { primary: () => ACCOUNT, forSession: () => ACCOUNT, list: () => [ACCOUNT] },
    recaptcha: { get: async () => "token" },
  });
  bridge.browser = { withAccount: async (_account, fn) => fn(), getPage: async () => ({}) };
  bridge.appendAgentMessage = async () => {};
  bridge.readLatestTurn = async () => ({
    text: "Task complete, 42 files checked.",
    nativeCalls: [{ id: "t1", name: "bash", rawInput: '{"command":"ls"}' }],
    turns: [],
    timing: { breakReason: "turn+marker" },
  });
  return { bridge, dataDir };
}

const ACCOUNT = { email: "acct@test.local" };
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("a real converse turn lands exactly one task record", async () => {
  const { bridge, dataDir } = makeBridge();
  assert.equal(bridge.telemetry.enabled, true);
  const payload = await bridge.converse(SESSION, { model: SESSION, messages: [{ role: "user", content: "check things" }] });
  assert.ok(payload?.choices?.[0]?.message?.content.includes("Task complete"));
  const records = readTaskRecords(dataDir);
  assert.equal(records.length, 1);
  assert.equal(records[0].chainKey, SESSION);
  assert.equal(records[0].kind, "converse");
  assert.equal(records[0].turns, 1);
  assert.ok(records[0].durationSec > 0);
  assert.ok(records[0].outputTokens > 0);
  assert.equal(records[0].nativeToolCalls, 1);
  assert.equal(records[0].bashCount, 1);
  assert.equal(records[0].bashFailures, 0);
});

test("the capture switch turns the wiring off cleanly", async () => {
  const { bridge, dataDir } = makeBridge({ telemetryCapture: false });
  assert.equal(bridge.telemetry.enabled, false);
  await bridge.converse(SESSION, { model: SESSION, messages: [{ role: "user", content: "check things" }] });
  assert.equal(readTaskRecords(dataDir).length, 0);
});

test("shell failure heuristic: exit codes and tracebacks, not the word error alone", () => {
  assert.ok(shellFailureText("Exit code: 1\n(command failed)"));
  assert.ok(shellFailureText("exit code=2"));
  assert.ok(shellFailureText("Traceback (most recent call last):"));
  assert.ok(shellFailureText("bash: foo: command not found"));
  assert.ok(shellFailureText("permission denied"));
  assert.ok(!shellFailureText("done, 0 errors, all tests green"));
  assert.ok(!shellFailureText("Exit code: 0"));
});

test("bash tool matcher covers the usual names", () => {
  for (const name of ["bash", "shell", "zsh", "run_command", "execute_command", "terminal", "local_shell", "executor"]) {
    assert.ok(BASH_TOOL_RE.test(name), name);
  }
  assert.ok(!BASH_TOOL_RE.test("web_search"));
  assert.ok(!BASH_TOOL_RE.test("file_edit"));
});

test("converse: one call is one task, native tool events land in the record", () => {
  const dir = tmpDir();
  const capture = new TelemetryCapture({ dataDir: dir });
  capture.recordTurn({
    chainKey: "session-a",
    kind: "converse",
    body: { messages: [{ role: "user", content: "do the thing" }] },
    payload: completion("All done."),
    nativeCalls: [
      { name: "bash", rawInput: '{"command":"ls"}' },
      { name: "bash", rawInput: '{"command":"grep"}', errored: true },
      { name: "file_edit", rawInput: '{"path":"x"}' },
    ],
    outputText: "All done.",
    durationSec: 40,
  });
  const records = readTaskRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].chainKey, "session-a");
  assert.equal(records[0].kind, "converse");
  assert.equal(records[0].turns, 1);
  assert.equal(records[0].durationSec, 40);
  assert.equal(records[0].nativeToolCalls, 3);
  assert.equal(records[0].toolCallCount, 3);
  assert.equal(records[0].bashCount, 2);
  assert.equal(records[0].bashFailures, 1); // the errored bash input
  // Fields the labeler ignores must not leak Sets or other unserializable state.
  assert.equal(records[0].bashIds, undefined);
});

test("runAgent: tool calls keep the task open; results and a user message close it", () => {
  const dir = tmpDir();
  const capture = new TelemetryCapture({ dataDir: dir });
  const tools = [{ function: { name: "shell" } }, { function: { name: "web_search" } }];

  // Turn 1: the model calls shell + a tool the client never advertised.
  capture.recordTurn({
    chainKey: "codex-1",
    kind: "agent",
    body: { messages: [{ role: "user", content: "check the build" }], tools },
    payload: completion("", [
      { id: "call-1", function: { name: "shell", arguments: '{"command":"make"}' } },
      { id: "call-2", function: { name: "deploy_to_mars", arguments: "{}" } },
    ]),
    durationSec: 12,
  });
  assert.equal(readTaskRecords(dir).length, 0); // still open
  assert.equal(capture.pendingCount(), 1);

  // Turn 2: results come back — one shell failure.
  capture.recordTurn({
    chainKey: "codex-1",
    kind: "agent",
    body: {
      messages: [
        { role: "user", content: "check the build" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", function: { name: "shell", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "Exit code: 1\nmake: *** [all] Error 1" },
      ],
      tools,
    },
    payload: completion("Build is broken in foo.c."),
    durationSec: 8,
  });
  const records = readTaskRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].turns, 2);
  assert.equal(records[0].durationSec, 20);
  assert.equal(records[0].toolCallCount, 2);
  assert.equal(records[0].toolHallucinations, 1); // deploy_to_mars was never advertised
  assert.equal(records[0].bashCount, 1);
  assert.equal(records[0].bashFailures, 1); // correlated via the remembered call id
  assert.ok(records[0].outputTokens > 0);

  // A dangling tool-call turn followed by a fresh user message cuts the old
  // task loose as truncated instead of merging two tasks into one.
  capture.recordTurn({
    chainKey: "codex-1",
    kind: "agent",
    body: { messages: [{ role: "user", content: "next task" }], tools },
    payload: completion("", [{ id: "call-9", function: { name: "shell", arguments: "{}" } }]),
    durationSec: 5,
  });
  assert.equal(readTaskRecords(dir).length, 1); // still open
  capture.recordTurn({
    chainKey: "codex-1",
    kind: "agent",
    body: { messages: [{ role: "user", content: "next task, without tools this time" }] },
    payload: completion("done"),
    durationSec: 4,
  });
  const all = readTaskRecords(dir);
  assert.equal(all.length, 3);
  assert.equal(all[1].truncated, true);
  assert.equal(all[1].turns, 1);
  assert.equal(all[2].truncated, undefined);
  assert.equal(all[2].turns, 1);
});

test("recordTurn never throws into a turn, and a disabled capture does nothing", () => {
  const dir = tmpDir();
  const capture = new TelemetryCapture({ dataDir: dir });
  // Malformed inputs of every kind must be swallowed.
  assert.doesNotThrow(() => capture.recordTurn(null));
  assert.doesNotThrow(() => capture.recordTurn({ chainKey: "x", body: { messages: "nope" }, payload: { choices: "nope" }, nativeCalls: "nope" }));
  assert.equal(readTaskRecords(dir).length, 0);

  const off = new TelemetryCapture({ dataDir: dir, enabled: false });
  off.recordTurn({ chainKey: "x", payload: completion("hi"), outputText: "hi", durationSec: 1 });
  assert.equal(off.pendingCount(), 0);
  assert.equal(readTaskRecords(dir).length, 0);
});

test("flushAll drains in-flight tasks as truncated and tolerates a torn last line", () => {
  const dir = tmpDir();
  const capture = new TelemetryCapture({ dataDir: dir });
  capture.recordTurn({
    chainKey: "codex-2",
    kind: "agent",
    body: { messages: [{ role: "user", content: "go" }], tools: [{ function: { name: "shell" } }] },
    payload: completion("", [{ id: "c1", function: { name: "shell", arguments: "{}" } }]),
    durationSec: 3,
  });
  assert.equal(capture.flushAll(), 1);
  assert.equal(capture.pendingCount(), 0);
  assert.equal(readTaskRecords(dir)[0].truncated, true);

  // A crash mid-append can leave a partial line; reading skips it.
  fs.appendFileSync(path.join(dir, TASKS_FILE), '{"chainKey": "torn', "utf8");
  const records = readTaskRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(readTaskRecords(dir, { chain: "codex-2" }).length, 1);
  assert.equal(readTaskRecords(dir, { chain: "other" }).length, 0);
});
