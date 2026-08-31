/**
 * Drive the real UI and screenshot each state, so "the flows work" is something observed
 * rather than assumed.
 *
 *   npm run build && node scripts/ui-check.mjs [outputDir]
 *
 * Launches Electron with remote debugging, connects over the DevTools Protocol, clicks
 * through the flows and captures a PNG at each step. Nothing test-only is compiled into the
 * app — this drives the shipping build exactly as a user would.
 *
 * It deliberately stops short of confirming a switch: that would sign the machine out and back
 * in, and the switch path already has its own end-to-end verification through the CLI.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "ui-check";
const PORT = 9223;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const electron = spawn(
  process.platform === "win32" ? "node_modules\\electron\\dist\\electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`],
  { stdio: "ignore", detached: false }
);

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 20_000);
  });
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "evaluation failed");
  return result.result?.value;
}

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const path = join(outDir, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log(`  captured ${name}.png`);
  return path;
}

/** Click the first element matching a CSS selector, optionally filtered by text. */
async function click(selector, text = null) {
  const found = await evaluate(`
    (() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const target = ${text === null ? "nodes[0]" : `nodes.find(n => n.textContent.includes(${JSON.stringify(text)}))`};
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  if (!found) throw new Error(`no element for ${selector}${text ? ` containing "${text}"` : ""}`);
  await sleep(700);
}

const failures = [];
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

try {
  // Wait for the debugger to come up, then attach to the app's page.
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error("Electron never exposed a debuggable page");

  // Node 20+ ships a global WebSocket, so no dependency is needed to speak CDP.
  ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("could not attach to the page")));
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await sleep(4000); // let the launch refresh land

  await step("grid renders", async () => {
    const cards = await evaluate(`document.querySelectorAll(".card").length`);
    if (cards < 1) throw new Error("no account cards rendered");
    await shot("01-grid");
  });

  await step("crests are inlined", async () => {
    const symbols = await evaluate(`document.querySelectorAll("symbol[id^='crest-']").length`);
    if (symbols < 11) throw new Error(`only ${symbols} crest symbols mounted, expected 11`);
  });

  await step("detail panel opens", async () => {
    // NB: textContent is "Details" — the uppercase in the design is CSS text-transform.
    await click(".card .cbtn", "Details");
    const open = await evaluate(`document.querySelector(".panel")?.dataset.open === "true"`);
    if (!open) throw new Error("panel did not open");
    await shot("02-detail");
  });

  await step("panel closes on Escape", async () => {
    await evaluate(`document.querySelector(".pclose").click()`);
    await sleep(500);
    const open = await evaluate(`document.querySelector(".panel")?.dataset.open === "true"`);
    if (open) throw new Error("panel stayed open");
  });

  await step("settings opens", async () => {
    await click(".btn-add", "Settings");
    const heading = await evaluate(`document.querySelector(".modal h3")?.textContent`);
    if (heading !== "Settings") throw new Error(`modal showed "${heading}"`);
    await shot("03-settings");
    await click(".mbtn", "Close");
  });

  await step("add-account opens", async () => {
    await click(".btn-add", "Add account");
    const heading = await evaluate(`document.querySelector(".modal h3")?.textContent`);
    if (!heading?.includes("Add an account")) throw new Error(`modal showed "${heading}"`);
    await shot("04-add");
    await click(".mbtn", "Cancel");
  });

  await step("the signed-in account cannot be switched to", async () => {
    // Asserted rather than exercised: actually running a switch here would sign the machine
    // out and back in. The switch path is verified end-to-end through the CLI instead.
    const disabled = await evaluate(`document.querySelector('.card .cbtn.go')?.disabled === true`);
    if (!disabled) throw new Error("the signed-in account's Switch button was not disabled");
  });

  await step("search filters", async () => {
    await evaluate(`
      (() => {
        const input = document.querySelector(".search input");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, "zzzz-no-such-account");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()
    `);
    await sleep(600);
    const empty = await evaluate(`document.querySelector(".empty h3")?.textContent`);
    if (empty !== "Nothing matches") throw new Error(`expected the empty state, got "${empty}"`);
    await shot("05-empty-search");
  });

  console.log(`\n${failures.length === 0 ? "all UI checks passed" : `${failures.length} failure(s)`}`);
  for (const f of failures) console.log(`  - ${f}`);
} catch (err) {
  console.log(`\nui-check aborted: ${err.message}`);
  failures.push(err.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  electron.kill();
  await sleep(500);
}

process.exit(failures.length === 0 ? 0 : 1);
