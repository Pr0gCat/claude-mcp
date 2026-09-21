// One-off repair of historical false successes. Original frames/events remain intact.
import Database from 'better-sqlite3';
import { chmodSync, renameSync } from 'node:fs';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/repair-result-status.mjs <state.sqlite> [--apply]');
const apply = process.argv.includes('--apply');
const db = new Database(path, { readonly: !apply, fileMustExist: true });
const latest = new Map();
for (const row of db.prepare("SELECT turn_id, payload FROM claude_events WHERE type = 'result' ORDER BY sequence ASC").iterate()) {
  const frame = JSON.parse(row.payload);
  if (frame.num_turns === 0 && frame.is_error !== true && !frame.result) continue;
  latest.set(row.turn_id, frame);
}
const candidates = db.prepare("SELECT t.id,t.agent_id,a.name FROM turns t JOIN agents a ON a.id=t.agent_id WHERE t.status='succeeded' AND a.state IN ('idle','closed','disconnected')").all()
  .filter(row => { const frame=latest.get(row.id); return frame?.is_error === true || frame?.terminal_reason === 'api_error'; });
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', corrections: candidates }));
if (apply && candidates.length) {
  const backup = path + '.before-result-fix-' + new Date().toISOString().replaceAll(':','-');
  const partial = backup + ".partial";
  await db.backup(partial, { progress: ({ totalPages }) => Math.max(1, totalPages) });
  chmodSync(partial, 0o600);
  renameSync(partial, backup);
  const now = new Date().toISOString();
  const count = db.transaction(() => {
    let count=0;
    for (const row of candidates) {
      const changed=db.prepare("UPDATE turns SET status='failed',updated_at=? WHERE id=? AND status='succeeded' AND EXISTS (SELECT 1 FROM agents WHERE id=turns.agent_id AND state IN ('idle','closed','disconnected'))").run(now,row.id).changes;
      if(!changed) continue;
      db.prepare('INSERT INTO events(agent_id,type,payload,created_at) VALUES(?,?,?,?)').run(row.agent_id,'turn.failed',JSON.stringify({turnId:row.id,status:'failed',reason:'Corrected legacy result classification: Claude reported an API error.',corrected_previous_status:'succeeded'}),now);
      db.prepare('UPDATE agents SET updated_at=? WHERE id=?').run(now,row.agent_id);
      count++;
    }
    return count;
  })();
  console.log(JSON.stringify({ corrected:count,backup }));
}
db.close();
