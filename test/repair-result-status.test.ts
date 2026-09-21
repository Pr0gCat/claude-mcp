import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('repairs only inactive false successes, backs up, preserves history, and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-status-repair-'));
  const path = join(dir, 'state.sqlite');
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,state TEXT,updated_at TEXT);
      CREATE TABLE turns(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,updated_at TEXT);
      CREATE TABLE events(agent_id TEXT,type TEXT,payload TEXT,created_at TEXT);
      CREATE TABLE claude_events(sequence INTEGER PRIMARY KEY,turn_id TEXT,payload TEXT,type TEXT DEFAULT 'result');
    `);
    for (const [id,state,status,isError] of [
      ['failed','idle','succeeded',true], ['ok','idle','succeeded',false],
      ['interrupted','idle','interrupted',true], ['active','running','succeeded',true],
    ] as const) {
      db.prepare('INSERT INTO agents VALUES(?,?,?,?)').run(id,id,state,'before');
      db.prepare('INSERT INTO turns VALUES(?,?,?,?)').run(id,id,status,'before');
      db.prepare('INSERT INTO claude_events(turn_id,payload) VALUES(?,?)').run(id,JSON.stringify({type:'result',subtype:'success',is_error:isError,result:isError?'ECONNRESET':'OK',num_turns:1}));
    }
    db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('failed','turn.completed','{}','before');
    const run = (...args: string[]) => execFileSync(process.execPath, ['scripts/repair-result-status.mjs', path, ...args], { encoding:'utf8' });
    run();
    expect(db.prepare("SELECT status FROM turns WHERE id='failed'").get()).toEqual({status:'succeeded'});
    run('--apply');
    run('--apply');
    expect(db.prepare('SELECT id,status FROM turns ORDER BY id').all()).toEqual([
      {id:'active',status:'succeeded'}, {id:'failed',status:'failed'},
      {id:'interrupted',status:'interrupted'}, {id:'ok',status:'succeeded'},
    ]);
    expect(db.prepare('SELECT type FROM events').all()).toEqual([{type:'turn.completed'},{type:'turn.failed'}]);
    expect(readdirSync(dir).filter(name => name.includes('before-result-fix'))).toHaveLength(1);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
