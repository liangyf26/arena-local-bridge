#!/usr/bin/env node
// arena-bridge — standalone entry point:
//  1) provisions DATA_DIR + .env (auto-generates an encryption key),
//  2) loads/creates credentials (login with email/password via bin/login.mjs),
//  3) boots the OpenAI-compatible HTTP bridge,
//  4) auto-refreshes the arena.ai session before the cookie expires,
//  5) graceful shutdown.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadDotEnv, loadConfig } from "./config.mjs";
import { CredentialStore } from "./credentials.mjs";
import { Bridge } from "./bridge.mjs";
import { RecaptchaBroker } from "./recaptcha.mjs";
import { createServer } from "./server.mjs";
import { log } from "./util.mjs";
import { requireSecret, restrictSecretFile, writeSecretFile } from "./secret.mjs";
import { detectBrowser } from "./browser-detect.mjs";
import { VERSION } from "./version.mjs";

const STARTED_AT = Date.now();

async function main() {
  // 1. Environment (DATA_DIR/.env overrides process env only when unset)
  const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
  const mergedEnv = { ...dotEnv, ...process.env };
  // Some flags are read via process.env deep inside modules (arena-login's
  // ARENA_HEADED), not through config — a scheduled task or service has no
  // shell to export them, so export the .env values back for those names.
  for (const name of ["ARENA_HEADED", "ARENA_LOCALE"]) {
    if (mergedEnv[name] !== undefined && process.env[name] === undefined) {
      process.env[name] = mergedEnv[name];
    }
  }
  let config = loadConfig(mergedEnv);
  log.info("boot", "arena-bridge starting", {
    version: VERSION,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
  });

  // 2. Provision a local encryption key (so credentials are encrypted at rest)
  //
  // Through writeSecretFile, not appendFileSync + a later chmod/icacls: appending
  // first and tightening after leaves the key in a file that could not be made
  // owner-only — the write succeeds, the ACL fails, the boot aborts, and the key
  // is on disk for anyone the directory allows. That is exactly the "written
  // owner-only or not written at all" the docs promise, so the key goes in the
  // same way every other secret does: unique tmp, restricted before the key is
  // in it, renamed over the target. A failure at any step leaves nothing.
  //
  // An existing .env is rewritten as its own content plus this line, which is
  // also how a copy left by an older version gets tightened.
  if (!dotEnv.STORAGE_ENCRYPTION_KEY) {
    const key = crypto.randomBytes(32).toString("hex");
    const existing = fs.existsSync(config.envPath) ? fs.readFileSync(config.envPath, "utf8") : "";
    writeSecretFile(config.envPath, `${existing}\nSTORAGE_ENCRYPTION_KEY=${key}\n`);
    dotEnv.STORAGE_ENCRYPTION_KEY = key;
    log.info("boot", "generated STORAGE_ENCRYPTION_KEY and wrote to " + config.envPath);
  } else {
    // A .env that was already here: tighten it, since a version before this one
    // left it under whatever the directory allows. Best effort — refusing to
    // start would leave an existing install with no way in — but it must not
    // pass quietly. (A .env this boot writes above is owner-only already, or
    // there is no .env at all.)
    try {
      restrictSecretFile(config.envPath);
    } catch (error) {
      log.error("boot", String(error?.message || error), {
        hint: "move DATA_DIR somewhere only you can read, or fix the ACL of that file",
      });
    }
  }

  // 3. Self-checks (fail fast with precise messages)
  const checks = [];
  if (config.chromePath && !fs.existsSync(config.chromePath)) {
    checks.push(`chromium binary not found at ${config.chromePath} (set ARENA_AGENT_CHROME)`);
  }
  if (!config.chromePath) {
    const { tried } = detectBrowser({ env: mergedEnv });
    checks.push(
      "no Chromium-based browser found (looked for Chrome, Edge and Playwright's own cache: " +
        `${tried.join(", ") || "nothing to look at on this platform"}). ` +
        "This project does not download one for you — install Chrome or Edge, or point at one with " +
        'ARENA_AGENT_CHROME (start-gui.bat passes it through), e.g. ' +
        'ARENA_AGENT_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".'
    );
  }
  if (!fs.existsSync(config.dataDir)) {
    checks.push(`DATA_DIR does not exist: ${config.dataDir}`);
  }
  if (checks.length) {
    for (const c of checks) log.error("boot", c);
    process.exit(1);
  }

  // 4. Credentials
  const secret = requireSecret(dotEnv);
  const credentials = new CredentialStore({
    filePath: config.credentialsFile,
    secret,
    omniDbPath: config.omniDbPath,
  }).load();
  let credential;
  try {
    credential = credentials.ensure({ migrateFromOmni: config.migrateFromOmni });
  } catch (error) {
    log.warn("boot", "no usable credentials; sign in through the GUI", {
      hint: `Open http://${config.host}:${config.port}/`,
      error: error.message,
    });
  }
  if (credential) {
    log.info("boot", "credential loaded; awaiting usability verification", {
      account: credential.email,
      cookieExpiry: credentials.expirySummary(credential),
      autoRefresh: Boolean(credentials.loginSecretFor(credential)),
    });
  }

  // 5. Browser + bridge + recaptcha
  // ARENA_AGENT_SPLIT_PROXY=1 — start a loopback host-splitting CONNECT proxy
  // and point the browser at it: allowlisted hosts (Google, for reCAPTCHA) go
  // through the configured socks5 upstream, arena.ai connects directly. See
  // src/split-proxy.mjs.
  if (mergedEnv.ARENA_AGENT_SPLIT_PROXY && config.proxy) {
    const { startSplitProxy } = await import("./split-proxy.mjs");
    const splitPort = Number(mergedEnv.ARENA_SPLIT_PROXY_PORT || 18080);
    startSplitProxy({ port: splitPort, upstream: config.proxy, proxyHosts: mergedEnv.ARENA_SPLIT_PROXY_HOSTS });
    log.info("boot", "split proxy enabled", {
      listen: `127.0.0.1:${splitPort}`,
      upstream: config.proxy,
      hosts: mergedEnv.ARENA_SPLIT_PROXY_HOSTS || "(default)",
    });
    config = { ...config, proxy: `http://127.0.0.1:${splitPort}` };
  }
  const bridge = new Bridge({ config, credentials, recaptcha: null, startedAt: STARTED_AT });
  bridge.launcherInstance = String(process.env.ARENA_LAUNCHER_INSTANCE || "");
  const recaptcha = new RecaptchaBroker({
    browser: bridge.browser,
    siteKey: config.recaptchaSiteKey,
    ttlMs: config.recaptchaTtlMs,
  });
  bridge.recaptcha = recaptcha;

  // First run must reach the GUI without spending a browser context or Arena
  // session. The existing login form launches the browser only on submission.
  if (credential) await bridge.start();

  // 6. HTTP server
  const server = createServer({ bridge, config });
  server.listen(config.port, config.host, () => {
    log.info("boot", `listening on http://${config.host}:${config.port}`, { mode: "stateless-claude-tools" });
  });

  /**
   * Walk the accounts in priority order until one both signs in AND is actually
   * usable. Arena signs in and hands out a valid-looking cookie for a restricted
   * account, then serves every session as a visitor — so "login returned 200" is
   * not enough. An account that fails here is disabled and the next one is tried,
   * instead of the bridge reporting healthy while every session fails.
   */
  async function ensureUsableAccount() {
    const tried = [];
    for (;;) {
      const account = credentials.selectNext(tried);
      if (!account) return null;
      const loginSecret = credentials.loginSecretFor(account);
      if (!loginSecret?.password) {
        log.warn("refresh", "no stored password; cannot verify account", { account: account.email });
        credentials.disable(account.email, "no stored password for verification");
        tried.push(account.email);
        continue;
      }
      try {
        const result = await bridge.browser.login(loginSecret.email, loginSecret.password);
        if (!credentials.replaceCookie(result.email, result.cookieHeader, account)) {
          log.info("refresh", "ignored outdated account verification", { account: account.email });
          return null;
        }
        bridge.readyAccounts.add(result.email.toLowerCase());
        // No close() here any more. The new cookie changes that Account's
        // credential signature, which marks its context stale; the next getPage
        // rebuilds it — once that Account is idle, so a refresh can no longer
        // kill the turn it was not meant to touch. (Closing the whole browser,
        // as this used to, took every OTHER Account's work down with it.)
        log.info("refresh", "account verified and refreshed", { account: result.email });
        return result.email;
      } catch (error) {
        // Proxy outages (v2rayN flap, node switch) fail navigation for EVERY
        // account equally and are nobody's fault — auto-disabling on them
        // took the whole pool down over a transient (observed twice). Only
        // Arena-side rejections (401/403 from arena.ai itself) say the
        // account is actually unusable.
        const msg = String(error?.message || "");
        if (/ERR_PROXY_CONNECTION_FAILED|proxy|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(RESET|TIMED_OUT|REFUSED)|timeout/i.test(msg)) {
          log.warn("refresh", "verification skipped: network/proxy outage (account NOT disabled)", {
            account: account.email,
            error: msg.slice(0, 120),
          });
          continue;
        }
        if (!credentials.disable(account.email, error.message, account)) {
          log.info("refresh", "ignored outdated account verification", { account: account.email });
          return null;
        }
        bridge.readyAccounts.delete(account.email.toLowerCase());
        tried.push(account.email);
        log.error("refresh", "account unusable; trying next", { account: account.email, error: error.message });
      }
    }
  }

  // 7. Verify after HTTP is available. The launcher can open the first-run GUI
  // from /health while a slow account login keeps /ready unavailable.
  // §4.41 — single-account re-login used by turns that hit a "Sign in to open
  // this chat" wall (session owner's cookie expired). Best-effort: failures
  // surface in the turn's retry, not here.
  bridge.refreshAccount = async (email) => {
    const account = credentials.accountSnapshot(email);
    if (!account || account.disabled || !account.loginSecret) return;
    const loginSecret = credentials.loginSecretFor(account);
    const result = await bridge.browser.login(loginSecret.email, loginSecret.password);
    if (credentials.replaceCookie(result.email, result.cookieHeader, account)) {
      bridge.readyAccounts.add(result.email.toLowerCase());
      log.info("refresh", "account re-logged (turn-time)", { account: result.email });
    }
  };
  // §4.41 — secondary accounts must not sit expired until the refresh tick
  // (tick interval == the margin, up to 20 minutes): every session owned by an
  // expired account fails with "Sign in to open this chat" until then.
  // MUST go through accountsNeedingRefresh(): list() projections hide
  // loginSecret/cookieHeader, which is why the old timer never refreshed
  // anyone (every `!account.loginSecret` was true, needsRefresh saw nothing).
  const refreshNearExpiryAccounts = async () => {
    for (const { account, email, secondsToExpiry: secs } of credentials.accountsNeedingRefresh(config.refreshMarginSec)) {
      log.info("refresh", "cookie near expiry; re-logging in", {
        account: email,
        expiry: `${Math.max(0, secs)}s`,
      });
      try {
        const loginSecret = credentials.loginSecretFor(account);
        const result = await bridge.browser.login(loginSecret.email, loginSecret.password);
        if (!credentials.replaceCookie(result.email, result.cookieHeader, account)) {
          log.info("refresh", "ignored outdated account verification", { account: email });
          continue;
        }
        bridge.readyAccounts.add(result.email.toLowerCase());
        log.info("refresh", "account verified and refreshed", { account: result.email });
      } catch (error) {
        const msg = String(error?.message || "");
        if (/ERR_PROXY_CONNECTION_FAILED|proxy|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(RESET|TIMED_OUT|REFUSED)|timeout/i.test(msg)) {
          log.warn("refresh", "verification skipped: network/proxy outage (account NOT disabled)", {
            account: email,
            error: msg.slice(0, 120),
          });
          continue;
        }
        // Background best-effort only: never auto-disable outside the tick.
        log.warn("refresh", "background account refresh failed (account NOT disabled)", {
          account: email,
          error: msg.slice(0, 120),
        });
      }
    }
  };
  ensureUsableAccount()
    .then(async (email) => {
      if (email) log.info("boot", "usable account confirmed", { account: email });
      else if (!bridge.healthPayload().ready) log.error("boot", "no usable Arena account", { error: credentials.lastLoginError });
      await refreshNearExpiryAccounts().catch(() => undefined);
    })
    .catch((error) => log.error("boot", "account verification crashed", { error: error.message }));

  // 8. Auto-refresh loop: re-login when the auth cookie approaches expiry.
  // EVERY account with a stored password is refreshed, not just the primary —
  // sessions owned by secondary accounts (see credentials.forSession) would
  // otherwise expire ~1h after their login and every turn on them would be
  // served as a visitor ("This chat belongs to another account").
  const refreshInterval = Math.max(60_000, config.refreshMarginSec * 1000);
  const refreshTimer = setInterval(async () => {
    const anyUsable = credentials.primary();
    if (!anyUsable) {
      log.error("refresh", "no usable account; attempting to recover", { error: credentials.lastLoginError });
      await ensureUsableAccount().catch(() => undefined);
      return;
    }
    // §4.41 — the old inline loop silently skipped every account: list()
    // projections carry no loginSecret/cookieHeader, so the guard and
    // needsRefresh were both dead. One shared path now (see
    // refreshNearExpiryAccounts) — background failures do NOT auto-disable.
    await refreshNearExpiryAccounts().catch(() => undefined);
  }, refreshInterval);
  refreshTimer.unref?.();

  // 9. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("boot", "shutting down");
    try {
      await server.stopMcp();
    } catch (error) {
      // Failed termination keeps a refusal listener bound to the old tunnel
      // port. Exiting here would release it to another local service while
      // that tunnel is still alive. Keep the keyed API available for retry.
      log.error("mcp", "shutdown deferred; retry MCP stop before exiting", { error: error.message });
      shuttingDown = false;
      return;
    }
    clearInterval(refreshTimer);
    server.close();
    await bridge.browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("unhandledRejection", (reason) => {
    log.error("boot", "unhandledRejection", { error: String(reason) });
  });
}

main().catch((error) => {
  log.error("boot", "fatal", { message: error.message, stack: error.stack });
  process.exit(1);
});
