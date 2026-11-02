#!/usr/bin/env node
// Usage: node state.mjs RUN_DIR [--out FILE]
// Read-only dump of every bounty row in the run's SQLite file, as JSON.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const [runDir, flag, out] = process.argv.slice(2);
if (!runDir) throw new Error("usage: node state.mjs RUN_DIR [--out FILE]");
const db = new DatabaseSync(`${runDir}/bountypay.db`, { readOnly: true });
const rows = db
  .prepare(
    "SELECT id, pr, payee, amount, state, reason, approved_by, payout_batch_id, payout_status, error, verdict FROM bounties ORDER BY id",
  )
  .all();
const json = JSON.stringify(rows, null, 2);
if (flag === "--out") writeFileSync(out, json + "\n");
console.log(json);
