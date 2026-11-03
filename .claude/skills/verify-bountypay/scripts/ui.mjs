#!/usr/bin/env node
// Usage:
//   node ui.mjs RUN_DIR snapshot NAME              grid text + screenshot into RUN_DIR/evidence/NAME.{txt,png}
//   node ui.mjs RUN_DIR click BOUNTY_ID LABEL NAME  click Approve|Reject on that row (Approve also answers its Pay confirm), wait, then snapshot as NAME
// Drives a throwaway headless Chrome (own profile under RUN_DIR) over the DevTools protocol.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [runDir, cmd, ...args] = process.argv.slice(2);
if (!runDir || !["snapshot", "click"].includes(cmd)) {
  console.error("usage: node ui.mjs RUN_DIR snapshot NAME | click BOUNTY_ID Approve|Reject NAME");
  process.exit(2);
}
const port = readFileSync(`${runDir}/port`, "utf8").trim();
const url = `http://localhost:${port}/`;
const chromeBin = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  chromeBin,
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${runDir}/chrome`, "--window-size=1600,1000", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const devtoolsPort = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("chrome did not start")), 15000);
});

try {
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

  const load = async () => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      if (await evaluate("!!document.querySelector('.ag-root') && !document.body.innerText.includes('Loading bounties')")) return;
      await sleep(500);
    }
    throw new Error("grid did not render");
  };
  const snapshot = async (name) => {
    await sleep(1500);
    const text = await evaluate(`[...new Set([...document.querySelectorAll('[row-id]')].map(r => r.getAttribute('row-id')))].map(id => {
      const parts = [...document.querySelectorAll('[row-id="' + id + '"]')];
      const cells = parts.flatMap(p => [...p.querySelectorAll('[col-id]')]).map(c => c.getAttribute('col-id') + '=' + c.innerText.trim().replace(/\\s+/g, ' ')).filter(c => !c.endsWith('='));
      const buttons = parts.flatMap(p => [...p.querySelectorAll('button')]).map(b => b.innerText.trim());
      return id + ' | ' + cells.join(' | ') + ' | buttons=' + buttons.join(',');
    }).join('\\n')`);
    writeFileSync(`${runDir}/evidence/${name}.txt`, (text || "(no rows)") + "\n");
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(`${runDir}/evidence/${name}.png`, Buffer.from(shot.result.data, "base64"));
    console.log(text || "(no rows)");
    console.log(`evidence: ${runDir}/evidence/${name}.txt and .png`);
  };

  await load();
  if (cmd === "snapshot") {
    await snapshot(args[0] ?? "grid");
  } else {
    const [bountyId, label, name] = args;
    const rowButton = (text) => `[...document.querySelectorAll('[row-id=' + ${JSON.stringify(JSON.stringify(bountyId))} + '] button')].find(b => b.innerText.trim() === ${JSON.stringify(text)})`;
    const click = (text) => evaluate(`(() => { const b = ${rowButton(text)}; if (!b) return false; b.click(); return true; })()`);
    if (!(await click(label))) throw new Error(`no "${label}" button on row ${bountyId} (row missing, or state does not allow it)`);
    if (label === "Approve") {
      await sleep(300);
      if (!(await click("Pay"))) throw new Error(`Approve on ${bountyId} did not ask "Pay ... to ...?"`);
    }
    await sleep(4000);
    const errorText = await evaluate("document.querySelector('.notice[data-tone=error]')?.innerText.replace(/\\s*×$/, '').trim() ?? ''");
    if (errorText) {
      writeFileSync(`${runDir}/evidence/${name}.alert.txt`, errorText + "\n");
      console.log(`dashboard error: ${errorText}`);
    }
    await load();
    await snapshot(name);
  }
  ws.close();
} finally {
  chrome.kill();
}
