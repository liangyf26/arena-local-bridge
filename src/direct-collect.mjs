// direct-collect.mjs — build the numeric fingerprint bank from Direct mode.
//
// Direct conversations expose the model by construction: the caller picks
// `model_a` in Arena's own UI, so a reply stored with that label is ground
// truth — the thing manual Agent-mode annotation can never be. One Direct
// session per model; the probe variants go out as consecutive messages.
//
// Route quirks this has to survive (all verified against the live site):
//   - the Direct composer only mounts via SPA navigation from a hydrated
//     /agent page; a fresh load of /text/direct never mounts it;
//   - the Direct composer is a <textarea> ("Ask anything…"), not the
//     contenteditable the Agent page uses;
//   - two "Send message" buttons coexist after the switch (the old Agent
//     form stays in the DOM) — target button[data-perf-target="send"];
//   - session creation can hit Arena's 429 rate limit, so creation retries
//     back off and the whole run aborts with a clear message when the window
//     outlasts the schedule.
import { probeTurn, variantIds } from "./fingerprint/probe-prompts.mjs";
import { appendRecord } from "./fingerprint/bank-store.mjs";
import { log } from "./util.mjs";

const MAX_KEEP = 60;
const REPLY_INTEGERS = /\b\d{1,3}\b/g;

export class DirectCollector {
  constructor({ bridge, credentials, dataDir, pulseFloor = 30, siteKey = "" }) {
    this.bridge = bridge;
    this.credentials = credentials;
    this.dataDir = dataDir;
    this.pulseFloor = pulseFloor;
    this.siteKey = siteKey;
    this.state = {
      running: false,
      stopRequested: false,
      total: 0,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      current: null,
      models: [],
    };
  }

  status() {
    return { ...this.state };
  }

  stop() {
    if (!this.state.running) return { ok: true, note: "not running" };
    this.state.stopRequested = true;
    return { ok: true, note: "stop requested; finishes the current model" };
  }

  #push(model) {
    this.state.models.push(model);
    if (this.state.models.length > MAX_KEEP) this.state.models.shift();
  }

  async start({ modelIds = [] } = {}) {
    if (this.state.running) return { ok: false, error: "collection already running" };
    const ids = [...new Set(modelIds.map((m) => String(m || "").trim()).filter(Boolean))];
    if (!ids.length) return { ok: false, error: "请提供至少一个模型 ID" };
    Object.assign(this.state, {
      running: true,
      stopRequested: false,
      total: ids.length,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
      current: null,
      models: [],
    });
    this.#run(ids)
      .catch((error) => {
        this.state.lastError = error?.message || String(error);
        log.error("direct-collect", "fatal", { error: this.state.lastError });
      })
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = Date.now();
        this.state.current = null;
      });
    return { ok: true, total: ids.length };
  }

  async #run(modelIds) {
    const credential = this.credentials.primary();
    if (!credential) throw new Error("没有可用账号，先登录 Arena");
    return this.bridge.browser.withAccount(credential, () => this.#runBatch(modelIds, credential));
  }

  async #runBatch(modelIds, credential) {
    const page = await this.bridge.browser.getPage(credential, "fingerprint");
    let pulse = await this.#readPulse(page);
    log.info("direct-collect", "start", { models: modelIds.length, pulse });

    for (const modelId of modelIds) {
      if (this.state.stopRequested) break;
      const model = { modelId, startedAt: Date.now(), sessionId: null, stored: 0, ok: false, error: null, pulse };
      this.#push(model);
      this.state.current = { modelId, phase: "进入 Direct 模式" };

      try {
        await this.#enterDirect(page);
        this.state.current = { modelId, phase: `选择模型 ${modelId}` };
        await this.#pickModel(page, modelId);

        for (const variant of variantIds()) {
          if (this.state.stopRequested) break;
          this.state.current = { modelId, phase: `探针 ${variant}`, variant };
          const reply = await this.#sendProbe(page, variant);
          if (!reply) throw new Error(`探针 ${variant} 未取到回复`);
          const record = appendRecord(this.dataDir, {
            text: reply,
            model: modelId,
            variant,
            condition: variant,
          });
          model.stored += 1;
          log.info("direct-collect", "sample stored", { modelId, variant, chars: record ? reply.length : 0 });
          await page.waitForTimeout(3_000);
        }

        model.sessionId = (page.url().match(/\/c\/([0-9a-f-]+)/) || [])[1] || null;
        model.ok = true;
        this.state.ok += 1;
        model.pulse = await this.#readPulse(page);
        if (model.pulse !== null && model.pulse < this.pulseFloor) {
          log.warn("direct-collect", "pulse below floor; stopping", { pulse: model.pulse, floor: this.pulseFloor });
          this.state.lastError = `账号容量（pulse ${model.pulse}%）低于安全线 ${this.pulseFloor}%，采集已暂停`;
          break;
        }
      } catch (error) {
        model.error = error?.message || String(error);
        this.state.failed += 1;
        this.state.lastError = model.error;
        log.error("direct-collect", "model failed", { modelId, error: model.error });
        if (error?.rateLimitExhausted) throw error;
      } finally {
        model.ms = Date.now() - model.startedAt;
        this.state.done += 1;
      }

      // back to /agent so the next model starts from a known SPA state
      if (this.state.done < this.state.total && !this.state.stopRequested) {
        await this.#backToAgent(page);
        await page.waitForTimeout(10_000);
      }
    }
  }

  async #readPulse(page) {
    return page
      .evaluate(async () => {
        try {
          const r = await fetch("/api/me/pulse", { headers: { Accept: "application/json" } });
          return (await r.json()).pulse ?? null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
  }

  /** /agent → hydrated composer → mode menu → Direct → textarea composer. */
  async #enterDirect(page) {
    if ((page.url() || "").startsWith("https://arena.ai/agent")) {
      const visible = await page
        .locator('[contenteditable="true"]')
        .last()
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (!visible) await page.goto("https://arena.ai/agent", { waitUntil: "domcontentloaded", timeout: 60_000 });
    } else {
      await page.goto("https://arena.ai/agent", { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page
      .locator('[contenteditable="true"]')
      .last()
      .waitFor({ state: "visible", timeout: this.composerWaitMs() })
      .catch(() => undefined);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /^Agent/i.test((b.innerText || "").trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(1_500);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] *')].find((e) =>
        /^Direct/i.test((e.innerText || "").trim())
      );
      if (item) item.click();
    });
    const box = page.locator('textarea[placeholder="Ask anything…"]').last();
    await box.waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(2_000);
  }

  async #pickModel(page, modelId) {
    const opened = await page.evaluate(() => {
      const direct = [...document.querySelectorAll("button")].find((b) => /^Direct$/i.test((b.innerText || "").trim()));
      const bar = direct?.closest('[class*="flex"]')?.parentElement || direct.parentElement;
      const target = [...bar.querySelectorAll("button")].find((b) => {
        const t = (b.innerText || "").trim();
        return t && !/^Direct$/i.test(t) && !/^(发送|Send)/i.test(t);
      });
      if (target) target.click();
      return target ? (target.innerText || "").trim() : null;
    });
    log.info("direct-collect", "model picker opened", { modelId, from: opened });
    await page.waitForTimeout(2_000);
    // The picker has a search box; type the id and click the row that names it.
    await page.evaluate((id) => {
      const search = [...document.querySelectorAll("input")].find((i) => /search|模型/i.test(i.placeholder || ""));
      if (!search) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(search, id);
      search.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, modelId);
    await page.waitForTimeout(2_000);
    const chose = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll('[role="menuitem"], [role="option"], [cmdk-item]')];
      const norm = id.toLowerCase().replace(/[^a-z0-9.]/g, "");
      const item =
        rows.find((e) => (e.innerText || "").trim().toLowerCase().replace(/[^a-z0-9.]/g, "") === norm) ||
        rows.find((e) => (e.innerText || "").trim().toLowerCase().includes(norm));
      if (item) {
        item.click();
        return (item.innerText || "").trim().slice(0, 60);
      }
      return null;
    }, modelId);
    if (!chose) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(`Direct 模型列表中找不到 "${modelId}"（该模型可能不开放 Direct 模式）`);
    }
    log.info("direct-collect", "model selected", { modelId, chose });
    // Picking a model re-renders the conversation area; the textarea goes away
    // and remounts on the fresh view. Wait it out before the first probe.
    await page
      .locator('textarea[placeholder="Ask anything…"]')
      .last()
      .waitFor({ state: "visible", timeout: 90_000 })
      .catch(() => undefined);
    await page.waitForTimeout(2_000);
  }

  /** Send one probe variant and return the reply text (the integer run after the prompt echo). */
  async #sendProbe(page, variant) {
    const prompt = probeTurn(variant);
    await page.waitForFunction(
      () => typeof globalThis.grecaptcha?.enterprise?.execute === "function",
      null,
      { timeout: 60_000, polling: 500 }
    ).catch(() => undefined);

    for (let attempt = 0; ; attempt++) {
      const box = page.locator('textarea[placeholder="Ask anything…"]').last();
      await box.waitFor({ state: "visible", timeout: 90_000 }).catch(() => undefined);
      // The fresh conversation view re-negotiates its own reCAPTCHA widget and
      // the send button stays disabled until that settles — same trap as the
      // Agent composer: "execute bound" is not "widget ready". Mint one token
      // to force the negotiation, then poll (re-filling as needed) for up to
      // ~90s before declaring the composer stuck.
      await page
        .evaluate(
          ({ siteKey }) =>
            new Promise((resolve) => {
              try {
                const mint = globalThis.grecaptcha?.enterprise?.execute(siteKey, { action: "chat_submit" });
                if (mint && typeof mint.then === "function") mint.then(() => resolve("ok"), () => resolve("rejected"));
                else resolve("unbound");
              } catch {
                resolve("threw");
              }
              setTimeout(() => resolve("timeout"), 60_000);
            }),
          { siteKey: this.siteKey }
        )
        .catch(() => undefined);
      let enabled = false;
      for (let i = 0; i < 30 && !enabled; i++) {
        // Re-fill every iteration: a fill that lands while React is still
        // hydrating the remounted view sets the DOM value without registering
        // it in component state, and the button stays disabled even though the
        // textarea "has" text. fill is idempotent, so keep re-applying until
        // the button reacts.
        await box.fill(prompt).catch(() => undefined);
        await page.waitForTimeout(3_000);
        enabled = await page
          .evaluate(() => [...document.querySelectorAll('button[data-perf-target="send"]')].some((b) => !b.disabled))
          .catch(() => false);
      }
      if (!enabled) throw new Error("Direct 发送按钮保持禁用（composer 未就绪）");
      const clicked = await page
        .evaluate(() => {
          const b = [...document.querySelectorAll('button[data-perf-target="send"]')].find((x) => !x.disabled);
          if (b) {
            b.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (!clicked) await box.press("Enter").catch(() => undefined);

      const clause = prompt.split("\n")[0].slice(0, 40);
      let reply = null;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(3_000);
        const s = await page
          .evaluate(
            ({ clause }) => {
              const text = document.body?.innerText || "";
              const echoAt = text.lastIndexOf(clause);
              const after = echoAt >= 0 ? text.slice(echoAt + clause.length) : "";
              // "live" = the composer was emptied again, i.e. the submission
              // went through — the send buttons themselves are ambiguous here
              // (the switched-away Agent form keeps its own in the DOM).
              const box = [...document.querySelectorAll('textarea[placeholder="Ask anything…"]')].pop();
              const live = box ? !box.value.trim() : false;
              const errorish = /prompt failed|出现错误|出错了|rate limit/i.test(text.slice(-600));
              return { after, live, errorish };
            },
            { clause }
          )
          .catch(() => ({ after: "", live: false, errorish: false }));
        if (s.errorish && !s.live) {
          const rateLimited = /rate limit|prompt failed/i.test(s.after || "");
          if (rateLimited && attempt < 3) {
            const waitMs = 60_000 * (attempt + 1);
            log.warn("direct-collect", "creation rate-limited; backing off", { variant, waitMs });
            await page.waitForTimeout(waitMs);
            break; // retry the same variant
          }
          throw new Error(`Arena 拒绝了探针（${s.after.slice(-120).trim()}）`);
        }
        const ints = s.after.match(REPLY_INTEGERS) || [];
        // the reply is complete when the composer is live again and the text
        // after the prompt echo holds a full integer run
        if (s.live && ints.length >= 30) {
          reply = ints.join(" ");
          break;
        }
      }
      if (reply) return reply;
      if (attempt >= 3) throw new Error(`探针 ${variant} 超时未取得完整回复`);
      await page.waitForTimeout(30_000);
    }
  }

  async #backToAgent(page) {
    await page.evaluate(() => {
      const direct = [...document.querySelectorAll("button")].find((b) => /^Direct$/i.test((b.innerText || "").trim()));
      if (!direct) return;
      const bar = direct.closest('[class*="flex"]')?.parentElement || direct.parentElement;
      const target = [...bar.querySelectorAll("button")].find((b) => /^Direct$/i.test((b.innerText || "").trim()));
      if (target) target.click();
    });
    await page.waitForTimeout(1_500);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] *')].find((e) =>
        /^Agent Mode/i.test((e.innerText || "").trim())
      );
      if (item) item.click();
    });
    await page
      .locator('[contenteditable="true"]')
      .last()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => undefined);
  }

  composerWaitMs() {
    return Number(process.env.ARENA_COMPOSER_WAIT_MS || 60_000);
  }
}
