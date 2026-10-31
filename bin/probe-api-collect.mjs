#!/usr/bin/env node
/**
 * bin/probe-api-collect.mjs — collect numeric-fingerprint reference replies
 * from models you can reach by API, where the model name is KNOWN.
 *
 * The Arena collector could not run (the reputation wall, then the Direct pool
 * lacking the target models), so the reference bank comes from labeled sources
 * instead. This file automates what bin/probe-cli.mjs does by hand: send the
 * probe prompt to a model over an OpenAI- or Anthropic-shaped API, take the
 * reply, and append it to the same fingerprint bank, tagged
 *   model     = the API model id (the label ground truth)
 *   condition = --env, the ENVIRONMENT the reply was produced in
 *
 * The condition is not cosmetic: buildBank refuses to attribute from a bank
 * with fewer than two conditions, because the SVD step needs them to project
 * the environment drift out of the comparison. Collect the SAME probes from a
 * second provider before trying to attribute Arena replies.
 *
 * Commands:
 *   collect <model>        run probe variants against one model and store
 *   list                   print the bank summary (same as probe-cli list)
 * Each request is stateless, which is exactly the fresh-conversation rule the
 * variants rely on — no context pollution between variants is possible.
 *
 * Secrets: the API key is read from an env var (--key-env) or a file
 * (--key-file), never from argv and never printed.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { variantIds, probeTurn, PROBE_COUNT } from "../src/fingerprint/probe-prompts.mjs";
import { appendRecord, readStore } from "../src/fingerprint/bank-store.mjs";

const [command, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
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
const format = (flag("format", "openai") || "").toLowerCase();
const baseUrl = (flag("base-url", "") || "").replace(/\/+$/, "");
const timeoutMs = numberFlag("timeout", 300_000);

function apiKey() {
  const envName = flag("key-env", "");
  if (envName) {
    const v = process.env[envName];
    if (!v) {
      console.error(`env var ${envName} is not set`);
      process.exit(2);
    }
    return v.trim();
  }
  const file = flag("key-file", "");
  if (file) return fs.readFileSync(file, "utf8").trim();
  console.error("provide the API key via --key-env <ENVVAR> or --key-file <path> (never argv)");
  process.exit(2);
}

async function complete(model, prompt) {
  const key = apiKey();
  const signal = AbortSignal.timeout(timeoutMs);
  if (format === "anthropic") {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: numberFlag("max-tokens", 16000),
        temperature: numberFlag("temperature", 0),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return text;
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: numberFlag("max-tokens", 16000),
      temperature: numberFlag("temperature", 0),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.choices?.[0]?.message?.content ?? "";
}

if (command === "collect") {
  const model = args[0];
  if (!model || !baseUrl) {
    console.error("usage: probe-api-collect.mjs collect <model> --base-url <url> [--format openai|anthropic] [--variant id] [--all-variants] [--env name] [--key-env V | --key-file f]");
    process.exit(2);
  }
  const env = flag("env", "api-" + new URL(baseUrl).hostname);
  const wanted = flag("variant", null);
  const variants = hasAllVariants() ? variantIds() : [wanted ?? "v1-instant"];
  for (const v of variants) {
    if (!variantIds().includes(v)) {
      console.error(`unknown variant "${v}". Options: ${variantIds().join(", ")}`);
      process.exit(2);
    }
  }
  for (const variant of variants) {
    const prompt = probeTurn(variant);
    process.stdout.write(`[${model}] ${variant} ... `);
    let text = "";
    try {
      text = await complete(model, prompt);
    } catch (error) {
      console.log(`FAILED: ${String(error?.message || error).slice(0, 140)}`);
      continue;
    }
    if (!text.trim()) {
      console.log("EMPTY reply (nothing stored)");
      continue;
    }
    const record = appendRecord(dataDir, { text, model, variant, condition: env, requestedCount: PROBE_COUNT });
    console.log(`${record.usable ? "stored" : "stored UNUSABLE"} landed=${record.landed}/${PROBE_COUNT} chars=${text.length}`);
  }
  const store = readStore(dataDir);
  console.log(`bank: ${store.records.length} record(s)`);
  process.exit(0);

  function hasAllVariants() {
    return process.argv.includes("--all-variants");
  }
}

if (command === "list") {
  const store = readStore(dataDir);
  if (!store.records.length) {
    console.log(`empty bank at ${path.join(dataDir, "fingerprint-bank.json")}`);
    process.exit(0);
  }
  const byModel = new Map();
  for (const r of store.records) {
    const key = `${r.model || "(unknown)"} | env=${r.condition || "?"}`;
    const entry = byModel.get(key) || { total: 0, usable: 0, variants: new Set() };
    entry.total += 1;
    entry.usable += r.usable ? 1 : 0;
    entry.variants.add(r.variant || "?");
    byModel.set(key, entry);
  }
  for (const [key, e] of [...byModel.entries()].sort()) {
    console.log(`${key}: ${e.usable}/${e.total} usable, variants ${[...e.variants].sort().join(",")}`);
  }
  process.exit(0);
}

console.error(`usage:
  probe-api-collect.mjs collect <model> --base-url <url>     probe one model into the bank
      [--format openai|anthropic] [--variant id | --all-variants] [--env name]
      [--key-env V | --key-file f] [--timeout ms] [--temperature t]
  probe-api-collect.mjs list                                 summarize the bank
Collect the same variants from a SECOND provider/environment before
attempting attribution — a one-condition bank cannot attribute across
environments.`);
process.exit(2);
