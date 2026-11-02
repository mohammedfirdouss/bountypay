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
    `SELECT b.id, b.pr, b.payee, b.amount, b.state, b.reason, b.approved_by, b.payout_batch_id,
       CASE WHEN b.state = 'sent' THEN COALESCE(s.status, 'pending') END AS payout_status, b.error, b.verdict
     FROM bounties b LEFT JOIN payout_status s ON s.batch_id = b.payout_batch_id ORDER BY b.id`,
  )
  .all();
const json = JSON.stringify(rows, null, 2);
if (flag === "--out") writeFileSync(out, json + "\n");
console.log(json);
