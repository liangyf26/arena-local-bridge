#!/usr/bin/env node
/**
 * bin/probe-cli.mjs — collect probe replies from clients you control
 *
 * The Arena collector could not run (the Direct pool lacks the target models),
 * so the reference bank comes from somewhere we can label ourselves: a client
 * where the model name is known. Paste the printed prompt into any chat client,
 * paste the reply back, and the record lands in the same bank the Arena
 * collector writes to.
 *
 * Commands:
 *   prompts [variant]            print probe prompt(s) to copy into a client
 *   add <model> <variant> <file> ingest a pasted reply (file or - for stdin)
 *   list                         summarize the bank
 *
 * Every record is tagged condition=<env>, where env comes from --env and
 * defaults to the hostname. Multiple models from the SAME client/environment
 * are what lets the bank project out that environment's drift — one model
 * alone cannot be calibrated.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { variantIds, probeTurn, variantOfPrompt, PROBE_COUNT } from "../src/fingerprint/probe-prompts.mjs";
import { appendRecord, readStore, probeStorePath } from "../src/fingerprint/bank-store.mjs";

const [command, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const dataDir = flag("data", path.join(os.homedir(), ".arena-bridge"));

if (command === "prompts") {
  const wanted = args[0];
  const ids = wanted ? [wanted] : variantIds();
  for (const id of ids) {
    console.log(`===== ${id} =====`);
    console.log(probeTurn(id));
    console.log();
  }
  console.error(`\n# ${ids.length} prompt(s). Send each as its own new chat, copy the full reply, save to a file, then:
#   node bin/probe-cli.mjs add <model> <variant> <reply.txt> --env <client-name>`);
  process.exit(0);
}

if (command === "add") {
  const [model, variant, file] = args;
  if (!model || !variant || !file) {
    console.error("usage: probe-cli.mjs add <model> <variant> <file|-> [--env name] [--data dir]");
    process.exit(2);
  }
  if (!variantIds().includes(variant)) {
    console.error(`unknown variant "${variant}". Options: ${variantIds().join(", ")}`);
    process.exit(2);
  }
  const text = (file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8")).trim();
  if (!text) {
    console.error("reply file is empty");
    process.exit(2);
  }
  const env = flag("env", os.hostname());
  const record = appendRecord(dataDir, {
    text,
    model,
    variant,
    condition: env,
    requestedCount: PROBE_COUNT,
  });
  const store = readStore(dataDir);
  const sameModel = store.records.filter((r) => r.model === model).length;
  console.log(
    `${record.usable ? "stored" : "stored UNUSABLE"}: model=${model} variant=${variant} env=${env} landed=${record.landed}/${PROBE_COUNT}` +
      (record.usable ? "" : " (too few numbers parsed — check the reply is just the numbers)"),
  );
  console.log(`bank: ${store.records.length} record(s), ${new Set(store.records.map((r) => r.model).filter(Boolean)).size} model(s)`);
  if (sameModel < 3) console.log(`note: ${model} has ${sameModel} record(s); aim for 3+ per model per environment`);
  process.exit(0);
}

if (command === "list") {
  const store = readStore(dataDir);
  if (!store.records.length) {
    console.log(`empty bank at ${probeStorePath(dataDir)}`);
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
  probe-cli.mjs prompts [variant]              print probe prompt(s) to paste into your client
  probe-cli.mjs add <model> <variant> <file>   ingest a reply (file or - for stdin)
  probe-cli.mjs list                           summarize the bank
  options: --env <name> (default hostname), --data <dir> (default ~/.arena-bridge)`);
process.exit(2);
