import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Bridge, resolveTarget, delay, exists, profilePID, processAlive } from '../scripts/lib/host.mjs';

const launcher = process.env.GOLAND_OPS_LIVE_IDE;
const sdk = process.env.GOLAND_OPS_LIVE_SDK;
const license = process.env.GOLAND_OPS_LIVE_LICENSE;
const enabled = !!(launcher && sdk && license && process.platform === 'win32');

// This is an opt-in functional test of the real IDE protocol and persistent effects.
// It creates a separate profile, project and processes. It never opens a business project.
test('real isolated IDE: configuration, Run, diagnostics, logs and Debug', { skip: !enabled, timeout: 480000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goland-ops-live-'));
  const project = path.join(root, 'project');
  const profile = path.join(root, 'config');
  const data = path.join(root, 'state');
  const results = [];
  let target;
  let bridge;
  let failure;
  async function fixtureScript(body, name, anyModality = true) {
    const script = path.join(root, name + '.groovy');
    const profileLiteral = normalized(profile).replaceAll("'", "\\'");
    await writeFile(script, "import com.intellij.openapi.application.*\nif(new File(PathManager.configPath).canonicalPath==new File('" + profileLiteral + "').canonicalPath)ApplicationManager.getApplication().invokeLater({" + body + "} as Runnable" + (anyModality ? ',ModalityState.any()' : '') + ")\n");
    const child = spawn(launcher, ['ideScript', script], { env: target.env, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    await delay(1500);
  }
  const xml = s => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const normalized = p => p.replaceAll('\\', '/');
  async function command(operation, args = {}, expected = 'ok', timeout = 20000) {
    let result = await bridge.send(operation, args, { timeout });
    for (let retry = 0; result.code === 'IDE_MODAL_DIALOG' && retry < 4; retry++) {
      await dismissFixtureIntro();
      result = await bridge.send(operation, args, { timeout });
    }
    results.push({ operation, result });
    console.log(operation + ': ' + result.outcome + ' ' + (result.code || ''));
    if (expected) assert.equal(result.outcome, expected, JSON.stringify(result));
    return result;
  }
  async function dismissFixtureIntro() {
    await fixtureScript("def observations=[];java.awt.Window.windows.findAll{it.visible && it instanceof javax.swing.JDialog}.each{d->def texts=[];def visit;visit={c->if((c instanceof javax.swing.JLabel || c instanceof javax.swing.AbstractButton) && c.text)texts.add(c.text);if(c instanceof java.awt.Container)c.components.each{visit(it)}};visit(d);observations.add([title:d.title,text:texts.take(20)]);if(texts.any{it.contains('GoLand Goes AI')||it.contains('Meet the Islands Theme')})d.dispose()};new File('" + normalized(path.join(root, 'fixture-dialogs.txt')).replaceAll("'", "\\'") + "').text=observations.inspect()", 'dismiss-fixture-ai');
  }
  const config = (name, args, file = 'main.go') => '<component name="ProjectRunConfigurationManager"><configuration default="false" name="' + xml(name) + '" type="GoApplicationRunConfiguration" factoryName="Go Application"><module name="probe"/><working_directory value="$PROJECT_DIR$"/><parameters value="' + xml(args) + '"/><envs><env name="GOTOOLCHAIN" value="local"/><env name="TEST_TOKEN" value="must-not-appear-in-output"/></envs><kind value="FILE"/><filePath value="$PROJECT_DIR$/' + file + '"/><directory value="$PROJECT_DIR$"/><method v="2"><option name="RunConfigurationTask" enabled="false" run_configuration_name="DoNotRun" run_configuration_type="GoApplicationRunConfiguration"/></method></configuration></component>';
  try {
    for (const folder of ['config/options', 'system', 'plugins', 'logs', 'project/.idea/runConfigurations', 'state'])
      await mkdir(path.join(root, folder), { recursive: true });
    await copyFile(license, path.join(profile, 'goland.key'));
    await writeFile(path.join(profile, 'options/go.sdk.xml'), '<application><component name="GoSdkList"><sdk-url><set><option value="file://' + xml(normalized(sdk)) + '"/></set></sdk-url></component></application>');
    await writeFile(path.join(profile, 'options/ide.general.xml'), '<application><component name="GeneralSettings"><option name="reopenLastProject" value="false"/></component></application>');
    const properties = path.join(root, 'idea.properties');
    await writeFile(properties, ['config', 'system', 'plugins', 'log'].map(k => 'idea.' + k + '.path=' + normalized(path.join(root, k === 'log' ? 'logs' : k))).join('\n'));
    const vmOptions = path.join(root, 'vmoptions');
    const originalVM = await readFile(path.join(path.dirname(launcher), 'goland64.exe.vmoptions'), 'utf8');
    await writeFile(vmOptions, originalVM + '\n-Djb.consents.confirmation.enabled=false\n-Didea.initially.ask.config=false\n-Didea.trust.all.projects=true\n');
    await writeFile(path.join(project, 'go.mod'), 'module goland-ops-live\n\ngo 1.25\n');
    const program = [
      'package main',
      'import ("fmt";"os";"time")',
      'func compute(input int) int {',
      ' before := input + 7',
      ' result := double(before) // BREAK',
      ' fmt.Println("COMPUTED", result) // AFTER',
      ' return result',
      '}',
      'func double(input int) int {',
      ' if len(os.Args)>3 {',
      '  deadline := time.Now().Add(90*time.Second)',
      '  for { if _,e:=os.Stat(os.Args[3]);e==nil { break }; if time.Now().After(deadline) { return -1 }; time.Sleep(50*time.Millisecond) }',
      ' }',
      ' return input*2',
      '}',
      'func main() {',
      ' fmt.Printf("READY pid=%d\\n", os.Getpid())',
      ' fmt.Println("TOKEN", os.Getenv("TEST_TOKEN"))',
      ' deadline := time.Now().Add(180*time.Second)',
      ' for {',
      '  if len(os.Args)>1 && os.Args[1]=="debug" { if _,e:=os.Stat(os.Args[2]); e==nil { break } }',
      '  if time.Now().After(deadline) { return }; time.Sleep(50*time.Millisecond)',
      ' }',
      ' fmt.Println("DONE", compute(5))',
      '}',
    ].join('\n');
    await writeFile(path.join(project, 'main.go'), program);
    await writeFile(path.join(project, 'broken.go'), 'package main\nfunc main() { this is not valid go }\n');
    await writeFile(path.join(project, '.idea/modules.xml'), '<project version="4"><component name="ProjectModuleManager"><modules><module fileurl="file://$PROJECT_DIR$/.idea/probe.iml" filepath="$PROJECT_DIR$/.idea/probe.iml"/></modules></component></project>');
    await writeFile(path.join(project, '.idea/probe.iml'), '<module type="WEB_MODULE" version="4"><component name="Go" enabled="true"/><component name="GoModuleSettings" enabled="true"/><component name="NewModuleRootManager"><content url="file://$MODULE_DIR$"/><orderEntry type="inheritedJdk"/><orderEntry type="sourceFolder" forTests="false"/></component></module>');
    await writeFile(path.join(project, '.idea/workspace.xml'), '<project version="4"><component name="GOROOT" url="file://' + xml(normalized(sdk)) + '"/></project>');
    await writeFile(path.join(project, '.idea/runConfigurations/run.xml'), config('Probe Run', 'run'));
    await writeFile(path.join(project, 'stepgate'), 'ready');
    await writeFile(path.join(project, '.idea/runConfigurations/debug.xml'), config('Probe Debug', 'debug "' + normalized(path.join(project, 'trigger')) + '" "' + normalized(path.join(project, 'stepgate')) + '"'));
    await writeFile(path.join(project, '.idea/runConfigurations/bad.xml'), config('Probe Bad', '', 'broken.go'));
    target = await resolveTarget({ ide: launcher, profile, project, dataDir: data, properties, vmOptions });
    bridge = new Bridge(target, { timeout: 30000 });
    let opened = await bridge.ensureProject();
    for (let setupWait = 0; opened.code === 'IDE_MODAL_DIALOG' && setupWait < 15; setupWait++) {
      // Only fixture setup dismisses the optional AI advertisement, without accepting terms.
      // Production code deliberately reports blockers instead of manipulating dialogs.
      await dismissFixtureIntro();
      opened = await bridge.send('project.probe');
    }
    results.push({ operation: 'project.ensure', result: opened });
    assert.equal(opened.outcome, 'ok', JSON.stringify(opened));
    for (let i = 0; i < 120; i++) {
      const probe = await command('project.probe');
      if (!probe.project.indexing) break;
      await delay(500);
    }
    await command('doctor');
    const inspected = await command('config.show', { config: 'Probe Run' });
    assert.ok(!JSON.stringify(inspected).includes('must-not-appear-in-output'));
    assert.equal(inspected.configuration.storage.shared, true);
    assert.ok(inspected.configuration.beforeRun.some(task => task.provider === 'RunConfigurationTask' && task.enabled === false));
    await command('config.check', { config: 'Probe Run' });
    const clone = await command('config.clone', { config: 'Probe Run', name: 'Probe Copy', patch: { programArguments: 'run' } });
    assert.equal(clone.configuration.storage.shared, false);
    assert.deepEqual(clone.configuration.beforeRun, inspected.configuration.beforeRun);
    const update = await command('config.update', { config: 'Probe Copy', revision: clone.configuration.revision, patch: { goToolArguments: '', environment: { CUSTOM: 'value' } } });
    assert.equal(update.configuration.name, 'Probe Copy');
    await command('config.update', { config: 'Probe Copy', revision: 'stale', patch: { programArguments: 'wrong' } }, 'failed');
    await command('config.clone', { config: 'Probe Run', name: 'Probe Copy' }, 'failed');
    const freshShared = await command('config.show', { config: 'Probe Run' });
    const shared = await command('config.update', { config: 'Probe Run', revision: freshShared.configuration.revision, patch: { goToolArguments: '' } });
    assert.equal(shared.configuration.storage.shared, true);
    let started = await command('run.start', { config: 'Probe Run' }, null, 20000);
    if (started.outcome !== 'ok') {
      await command('attempt.show', { request: started.requestId }, null);
      await command('doctor', {}, null);
      await dismissFixtureIntro();
      for (let i = 0; i < 20 && started.outcome === 'unknown'; i++) {
        await delay(200);
        started = await bridge.send('run.start', { config: 'Probe Run' }, { id: started.requestId });
      }
      assert.equal(started.outcome, 'ok', JSON.stringify(started));
    }
    await command('run.start', { config: 'Probe Run' }, 'failed');
    const session = started.session;
    const log = await command('logs', { session, tail: 100 });
    assert.match(log.output, /READY pid=/);
    assert.ok(!JSON.stringify(log).includes('must-not-appear-in-output'));
    const startAttempt = await command('attempt.show', { request: started.requestId });
    assert.ok(!JSON.stringify(startAttempt).includes('must-not-appear-in-output'));
    const extra = await command('logs', { session, cursor: log.cursor, tail: 100 });
    assert.equal(extra.gap, false);
    const clearProject = normalized(project).replaceAll("'", "\\'");
    await fixtureScript("def p=com.intellij.openapi.project.ProjectManager.getInstance().openProjects.find{it.basePath && java.nio.file.Files.isSameFile(new File(it.basePath).toPath(),new File('" + clearProject + "').toPath())};def d=com.intellij.execution.ui.RunContentManager.getInstance(p).allDescriptors.find{it.displayName=='Probe Run'};def c=d.executionConsole;for(int i=0;i<4 && c.metaClass.respondsTo(c,'getDelegate');i++)c=c.delegate;c.clear()", 'clear-fixture-console', false);
    assert.equal((await command('logs', { session, cursor: log.cursor })).gap, true);
    const restarted = await command('run.restart', { session }, 'ok', 45000);
    assert.notEqual(restarted.session, session);
    await command('run.stop', { session: restarted.session });
    const bad = await command('run.start', { config: 'Probe Bad' }, null, 15000);
    assert.equal(bad.outcome, 'failed', JSON.stringify(bad));
    const attempt = await command('attempt.show', { request: bad.requestId });
    assert.ok(attempt.attempt.phase);
    assert.match((attempt.attempt.output || '') + (bad.output || ''), /syntax error|unexpected|not valid/i);

    const task = 'live-debug-test';
    const bp = await command('breakpoint.set', { file: 'main.go', line: 5, task });
    const debug = await command('debug.start', { config: 'Probe Debug' }, 'ok', 45000);
    const debugSession = debug.debug.session;
    await writeFile(path.join(project, 'trigger'), 'go');
    const paused = await command('debug.wait', { session: debugSession, state: 'paused' });
    assert.equal(paused.debug.position.line, 5);
    const pause = paused.debug.pause;
    const stack = await command('debug.stack', { session: debugSession, pause, limit: 20 });
    assert.equal(stack.frames[0].line, 5);
    const frame = stack.frames[0].frame;
    const locals = await command('debug.variables', { session: debugSession, pause, frame, limit: 30 });
    assert.ok(locals.variables.some(v => v.name === 'before' && v.value === '12'));
    const evaluation = await command('debug.eval', { session: debugSession, pause, frame, expression: 'before' });
    assert.equal(evaluation.result.value, '12');
    await command('debug.eval', { session: debugSession, pause, frame, expression: 'panic(1)' }, 'failed');
    const stepped = await command('debug.step-over', { session: debugSession, pause });
    assert.equal(stepped.debug.position.line, 6);
    await command('debug.variables', { session: debugSession, pause, frame }, 'failed');
    const next = await command('debug.variables', { session: debugSession, pause: stepped.debug.pause, limit: 30 });
    assert.ok(next.variables.some(v => v.name === 'result' && v.value === '24'));
    await command('debug.continue', { session: debugSession, pause: stepped.debug.pause });
    await command('debug.wait', { session: debugSession, state: 'stopped' });
    await command('breakpoint.cleanup', { task });
    const owned = await command('breakpoint.list');
    assert.ok(!owned.breakpoints.some(b => b.owned));

    // A deliberately blocking step must remain interruptible rather than deadlocking its config.
    await rm(path.join(project, 'trigger'), { force: true });
    await rm(path.join(project, 'stepgate'), { force: true });
    await command('breakpoint.set', { file: 'main.go', line: 5, task: 'long-step' });
    const longDebug = await command('debug.start', { config: 'Probe Debug' });
    await writeFile(path.join(project, 'trigger'), 'go');
    const longPaused = await command('debug.wait', { session: longDebug.debug.session, state: 'paused' });
    const stepPending = await command('debug.step-over', { session: longDebug.debug.session, pause: longPaused.debug.pause }, 'unknown', 3000);
    await command('debug.continue', { session: longDebug.debug.session }, 'failed');
    const interrupted = await command('debug.pause', { session: longDebug.debug.session });
    const stepOutcome = await command('attempt.show', { request: stepPending.requestId });
    assert.equal(stepOutcome.attempt.result.code, 'INTERRUPTED');
    await command('debug.stop', { session: longDebug.debug.session, pause: interrupted.debug.pause });
    await command('breakpoint.cleanup', { task: 'long-step' });

    // A manual Run is created outside the tool's launch listener, then discovered and controlled.
    await command('config.clone', { config: 'Probe Run', name: 'Probe Manual' });
    const projectLiteral = normalized(project).replaceAll("'", "\\'");
    const fixtureProject = "def p=com.intellij.openapi.project.ProjectManager.getInstance().openProjects.find{it.basePath && java.nio.file.Files.isSameFile(new File(it.basePath).toPath(),new File('" + projectLiteral + "').toPath())};assert p!=null;";
    await fixtureScript(fixtureProject + "def s=com.intellij.execution.RunManager.getInstance(p).allSettings.find{it.name=='Probe Manual'};com.intellij.execution.ProgramRunnerUtil.executeConfiguration(s,com.intellij.execution.executors.DefaultRunExecutor.getRunExecutorInstance())", 'manual-run', false);
    let manual;
    for (let i = 0; i < 30; i++) {
      const status = await command('run.status', { config: 'Probe Manual' });
      manual = status.sessions.find(s => s.state === 'running');
      if (manual) break;
      await delay(200);
    }
    assert.ok(manual);
    assert.match((await command('logs', { session: manual.session })).output, /READY/);
    const manualRestart = await command('run.restart', { session: manual.session }, 'ok', 45000);
    await command('run.stop', { session: manualRestart.session });

    // Discover two manually launched Debug sessions of the same configuration.
    await rm(path.join(project, 'trigger'), { force: true });
    const manualDebug = fixtureProject + "def s=com.intellij.execution.RunManager.getInstance(p).allSettings.find{it.name=='Probe Debug'};s.configuration.setAllowRunningInParallel(true);com.intellij.execution.ProgramRunnerUtil.executeConfiguration(s,com.intellij.execution.executors.DefaultDebugExecutor.getDebugExecutorInstance())";
    await fixtureScript(manualDebug, 'manual-debug-one', false);
    await fixtureScript(manualDebug, 'manual-debug-two', false);
    let debugSessions;
    for (let i = 0; i < 30; i++) {
      debugSessions = (await command('debug.list')).sessions.filter(s => s.state !== 'stopped');
      if (debugSessions.length === 2) break;
      await delay(200);
    }
    assert.equal(debugSessions.length, 2);
    await command('run.start', { config: 'Probe Debug' }, 'failed');
    await command('breakpoint.set', { file: 'main.go', line: 5, config: 'Probe Debug', task: 'ambiguous-test' }, 'failed');
    const runDebug = (await command('run.status')).sessions.find(s => s.executor.includes('Debug') && s.state === 'running');
    await command('run.stop', { session: runDebug?.session || debugSessions[0].session }, 'failed');
    const pausedOne = await command('debug.pause', { session: debugSessions[0].session });
    assert.equal(pausedOne.debug.state, 'paused');
    assert.equal((await command('debug.status', { session: debugSessions[1].session })).debug.state, 'running');
    await command('debug.stop', { session: debugSessions[0].session, pause: pausedOne.debug.pause });
    await command('debug.stop', { session: debugSessions[1].session });

    // Preserve a user's breakpoint, and do not adopt changes to a tool-created breakpoint.
    await fixtureScript(fixtureProject + "def vf=com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(p.basePath+'/main.go');def t=com.intellij.xdebugger.XDebuggerUtil.getInstance().lineBreakpointTypes.find{it.id=='DlvLineBreakpoint'};ApplicationManager.getApplication().runWriteAction({com.intellij.xdebugger.XDebuggerManager.getInstance(p).breakpointManager.addLineBreakpoint(t,vf.url,5,t.createBreakpointProperties(vf,5))} as Runnable)", 'user-breakpoint', false);
    const reused = await command('breakpoint.set', { file: 'main.go', line: 6, task: 'user-preservation' });
    assert.equal(reused.reused, true);
    assert.equal(reused.breakpoint.owned, false);
    await command('breakpoint.disable', { breakpoint: reused.breakpoint.breakpoint, revision: reused.breakpoint.revision, task: 'user-preservation' }, 'failed');
    const explicitDisable = await command('breakpoint.disable', { breakpoint: reused.breakpoint.breakpoint, revision: reused.breakpoint.revision, task: 'user-preservation', allowUserBreakpoint: true });
    assert.equal(explicitDisable.breakpoint.owned, false);
    await command('breakpoint.enable', { breakpoint: explicitDisable.breakpoint.breakpoint, revision: explicitDisable.breakpoint.revision, task: 'user-preservation', allowUserBreakpoint: true });
    const recoverable = await command('breakpoint.set', { file: 'main.go', line: 5, task: 'persistence-task' });
    await fixtureScript(fixtureProject + "def b=com.intellij.xdebugger.XDebuggerManager.getInstance(p).breakpointManager.allBreakpoints.find{it.sourcePosition?.line==4};ApplicationManager.getApplication().runWriteAction({b.setCondition('input == 5')} as Runnable)", 'simulate-user-edit', false);
    const changed = (await command('breakpoint.list')).breakpoints.find(b => b.breakpoint === recoverable.breakpoint.breakpoint);
    await command('breakpoint.disable', { breakpoint: changed.breakpoint, revision: changed.revision, task: 'persistence-task' }, 'failed');
    const conflicted = await command('breakpoint.cleanup', { task: 'persistence-task' }, 'blocked');
    assert.ok(conflicted.breakpoints.some(b => b.state === 'conflict'));
    const beforeRunEdit = (await command('config.show', { config: 'Probe Run' })).configuration;
    assert.equal(beforeRunEdit.sdk.state, 'configured');
    const beforeExpiry = await command('config.show', { config: 'Probe Copy' });
    const expired = await bridge.send('config.update', { config: 'Probe Copy', revision: beforeExpiry.configuration.revision, patch: { programArguments: 'MUST_NOT_EXECUTE' } }, { timeout: 1 });
    await delay(1500);
    const expiredResult = await bridge.send('config.update', {}, { id: expired.requestId });
    assert.equal(expiredResult.code, 'EXPIRED_BEFORE_DISPATCH');
    assert.equal((await command('config.show', { config: 'Probe Copy' })).configuration.programArguments, beforeExpiry.configuration.programArguments);

    // Normal project/IDE reopen must retain local/shared storage and ownership evidence.
    const closedPid = await profilePID(profile);
    await fixtureScript("ApplicationManager.getApplication().invokeLater({com.intellij.openapi.application.ex.ApplicationManagerEx.getApplicationEx().exit(false,true)} as Runnable)", 'reopen-save-exit');
    for (let i = 0; i < 100 && (await profilePID(profile) || (closedPid && processAlive(closedPid))); i++) await delay(100);
    const reopened = await bridge.ensureProject();
    assert.equal(reopened.outcome, 'ok', JSON.stringify(reopened));
    const persistedCopy = await command('config.show', { config: 'Probe Copy' });
    assert.equal(persistedCopy.configuration.storage.shared, false);
    assert.ok(Object.hasOwn(persistedCopy.configuration.environment, 'CUSTOM'));
    assert.deepEqual(persistedCopy.configuration.beforeRun, clone.configuration.beforeRun);
    assert.equal((await command('config.show', { config: 'Probe Run' })).configuration.storage.shared, true);
    assert.equal((await command('breakpoint.list')).breakpoints.find(b => b.line === 6).owned, false);
    await command('breakpoint.cleanup', { task: 'persistence-task' }, 'blocked');
  } catch (error) { failure = error; }
  finally {
    if (bridge) {
      try {
        const status = await bridge.send('run.status');
        for (const s of status.sessions || []) {
          if (s.state === 'running' && !s.executor.includes('Debug')) await bridge.send('run.stop', { session: s.session });
        }
        const ds = await bridge.send('debug.list');
        for (const s of ds.sessions || []) if (s.state !== 'stopped') await bridge.send('debug.stop', { session: s.session, pause: s.pause });
      } catch {}
    }
    // Test-only cleanup, profile identity is checked inside the IDE before normal exit.
    const ownPid = target ? await profilePID(profile) : null;
    if (ownPid) {
      await fixtureScript("java.awt.Window.windows.findAll{it.visible && it instanceof javax.swing.JDialog}.each{it.dispose()};ApplicationManager.getApplication().invokeLater({com.intellij.openapi.application.ex.ApplicationManagerEx.getApplicationEx().exit(false,true)} as Runnable)", 'exit-fixture');
      for (let i = 0; i < 100 && await profilePID(profile); i++) await delay(100);
      for (let i = 0; i < 100 && processAlive(ownPid); i++) await delay(100);
    }
    await writeFile(path.join(root, 'evidence.json'), JSON.stringify(results, null, 2));
    // Never retain the copied license in diagnostics.
    await rm(path.join(profile, 'goland.key'), { force: true });
    if (failure || process.env.GOLAND_OPS_KEEP_EVIDENCE) console.log('temporary evidence: ' + root);
    else if (!(await profilePID(profile))) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    if (failure) throw failure;
  }
});
