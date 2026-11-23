import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { cleanupTempEvidenceFile, preflightT3Thread, collectSubagentEvidence } from '../skills/yjx-retro/scripts/extract-session-evidence.mjs';

// Structural persistence fixtures; these do not evaluate model or prompt behavior.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-regression-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,title TEXT,created_at TEXT,deleted_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY,thread_id TEXT,ordinal INTEGER,provider_instance_id TEXT,provider_thread_id TEXT,status TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,provider_thread_id TEXT,ordinal INTEGER,type TEXT,status TEXT,updated_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT,thread_id TEXT,run_id TEXT,child_thread_id TEXT,origin TEXT,started_at TEXT);
  `);
  const ts = '2020-01-02T00:00:00.000Z';
  const thread = id => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,NULL,?)').run(id,id,'2020-01-01T00:00:00Z','{}');
  const run = (id, n, status='completed') => db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,?,?)').run(id,'root',n,'codex','pt',status,'{}');
  const item = (id, owner, runId, ordinal, type, payload={}) => db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?,?,?)').run(id,owner,runId,'pt',ordinal,type,'completed',ts,JSON.stringify({startedAt:ts,...payload}));
  thread('root');
  return {dir,dbPath,db,thread,run,item,ts};
}

test('rolled_back retro remains evidence but cannot become automatic baseline', t => {
  const f=fixture(t);
  f.run('r1',1); f.run('r2',2,'rolled_back'); f.run('r3',3,'running');
  f.item('old','root','r1',10,'user_message',{text:'$yjx-retro'});
  f.item('compaction','root','r2',15,'compaction');
  f.item('withdrawn','root','r2',20,'user_message',{text:'$yjx-retro'});
  f.item('current','root','r3',30,'user_message',{text:'$yjx-retro'});
  let result=preflightT3Thread(f.dbPath,'root');
  assert.equal(result.rangeStartOrdinal,10);
  assert.equal(result.route,'full');
  assert.equal(result.retroInvocations.find(i=>i.itemId==='withdrawn').runStatus,'rolled_back');
  assert.equal(preflightT3Thread(f.dbPath,'root',{sinceOrdinal:20}).rangeStartOrdinal,20);
  f.db.prepare("UPDATE orchestration_v2_projection_runs SET status='rolled_back' WHERE run_id='r1'").run();
  result=preflightT3Thread(f.dbPath,'root');
  assert.equal(result.previousRetro,null);
  assert.equal(result.rangeStartOrdinal,null);
});

test('structural child IDs are read despite unresolved parent points; actual body gaps stay distinct', async t => {
  const f=fixture(t); f.run('r1',1);
  f.item('root-item','root','r1',10,'assistant_message',{text:'root result'});
  f.thread('child'); f.thread('empty'); f.thread('late'); f.thread('nested');
  f.item('child-item','child',null,1,'assistant_message',{text:'child result'});
  f.item('nested-item','nested',null,1,'assistant_message',{text:'nested result'});
  const insert=f.db.prepare('INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?,?,?)');
  for (const id of ['child','empty','missing']) insert.run(id,'root','unresolved-run',id,'provider_native',f.ts);
  insert.run('late','root','unresolved-run','late','provider_native','2020-03-01T00:00:00Z');
  insert.run('nested','child','unresolved-run','nested','provider_native',f.ts);
  const result=await collectSubagentEvidence({sessionId:'root',t3Db:f.dbPath,untilOrdinal:10,untilTime:'2020-02-01T00:00:00Z'});
  const child=result.children.find(c=>c.id==='child');
  assert.equal(child.evidence.eventCount,1);
  assert.equal(child.evidence.result.preview,'child result');
  assert.ok(child.parents.some(p=>p.gaps.some(g=>g.reason==='root-association-run-unresolved')));
  assert.ok(result.gaps.some(g=>g.reason==='root-association-item-unresolved'));
  assert.ok(result.children.find(c=>c.id==='empty').evidence.gaps.some(g=>g.reason==='child-events-unavailable'));
  assert.equal(result.children.find(c=>c.id==='missing').evidence.coverage,'missing');
  assert.equal(result.children.some(c=>c.id==='late'),false);
  assert.equal(result.children.find(c=>c.id==='nested').evidence.eventCount,1);
});

test('tool-only child discovery expands its structural descendants without applying root ordinals', async t => {
  const f=fixture(t); f.run('r1',1); f.thread('child'); f.thread('nested');
  f.item('dispatch','root','r1',10,'dynamic_tool',{
    toolName:'spawn_agent', input:'{}', output:JSON.stringify({childThreadId:'child'}),
  });
  f.item('child-item','child',null,1000001,'assistant_message',{text:'child result'});
  f.item('nested-item','nested',null,2000001,'assistant_message',{text:'nested result'});
  f.db.prepare('INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?,?,?)')
    .run('nested','child','unresolved-run','nested','provider_native',f.ts);
  const result=await collectSubagentEvidence({sessionId:'root',t3Db:f.dbPath,untilOrdinal:10,untilTime:'2020-02-01T00:00:00Z'});
  assert.deepEqual(result.children.map(c=>c.id).sort(),['child','nested']);
  assert.equal(result.children.find(c=>c.id==='nested').evidence.eventCount,1);
});

test('cleanup canonicalizes actual temp aliases and preserves deletion restrictions', t => {
  const f=fixture(t);
  const target=path.join(f.dir,'retro-evidence.md');
  fs.writeFileSync(target,'evidence');
  let alias=path.join(fs.realpathSync.native(f.dir),'retro-evidence.md');
  if(process.platform==='win32') alias=alias.toUpperCase();
  assert.equal(cleanupTempEvidenceFile(alias).cleaned,true);
  assert.equal(fs.existsSync(target),false);
  assert.equal(cleanupTempEvidenceFile(target).reason,'not-found');
  assert.throws(()=>cleanupTempEvidenceFile(path.join(f.dir,'other.md')),/non-retro/);
  const directory=path.join(f.dir,'retro-directory.md'); fs.mkdirSync(directory);
  assert.throws(()=>cleanupTempEvidenceFile(directory),/non-regular/);
  const outside=fs.mkdtempSync(path.join(process.cwd(),'retro-outside-'));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const outsideFile=path.join(outside,'retro-evidence.md'); fs.writeFileSync(outsideFile,'keep');
  assert.throws(()=>cleanupTempEvidenceFile(outsideFile),/outside system temp/);
  const link=path.join(f.dir,'escape');
  fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>cleanupTempEvidenceFile(path.join(link,'retro-evidence.md')),/outside system temp/);
  assert.equal(fs.readFileSync(outsideFile,'utf8'),'keep');
  if(process.platform!=='win32') {
    const fileLink=path.join(f.dir,'retro-link.md'); fs.symlinkSync(outsideFile,fileLink);
    assert.throws(()=>cleanupTempEvidenceFile(fileLink),/non-regular/);
  }
});
