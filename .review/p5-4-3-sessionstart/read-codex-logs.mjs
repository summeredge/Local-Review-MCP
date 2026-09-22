// P5.4.3.2 verification-only reader: searches the Codex app-server log database for hook-lifecycle
// records around this experiment. Read-only (readOnly sqlite handle); prints matching text only.
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? "C:\\Users\\shaoy\\.codex\\logs_2.sqlite";
const pattern = process.argv[3] ?? "hook";
const sinceSeconds = Number(process.argv[4] ?? 3600);
const limit = Number(process.argv[5] ?? 30);

const db = new DatabaseSync(dbPath, { readOnly: true });
const since = Math.floor(Date.now() / 1000) - sinceSeconds;
const targetOnly = pattern.startsWith("target:");
const needle = targetOnly ? pattern.slice("target:".length) : pattern;
const rows = targetOnly
  ? db.prepare(`
      select ts, level, target, substr(feedback_log_body, 1, 700) as body
      from logs where ts >= ? and target like ? order by ts desc limit ?
    `).all(since, `%${needle}%`, limit)
  : db.prepare(`
      select ts, level, target, substr(feedback_log_body, 1, 700) as body
      from logs
      where ts >= ? and target not like 'feedback_tags%'
        and (target like ? or feedback_log_body like ?)
      order by ts desc
      limit ?
    `).all(since, `%${needle}%`, `%${needle}%`, limit);
console.log(JSON.stringify({ dbPath, pattern, window_hours: sinceSeconds / 3600, matches: rows.length }, null, 2));
for (const row of rows) {
  console.log(`${new Date(row.ts * 1000).toISOString()} [${row.level}] ${row.target}: ${String(row.body).replace(/\s+/g, " ")}`);
}
db.close();
