import { sendCodex, validateThreadId } from './codex.mjs';
import { inspectTarget } from './target.mjs';
import { inspectT3Target, sendT3 } from './t3.mjs';

// Source UUIDs remain immutable routing identities. Explicit per-group aliases
// transfer only named sources; they never change historical send fingerprints.
export function validateAgentTargets(config) {
  if(config.t3Command!==undefined && (!Array.isArray(config.t3Command) || !config.t3Command.length || config.t3Command.some(x=>typeof x!=='string'||!x))) throw new Error('Invalid T3 executable argv');
  if(config.t3BaseDir!==undefined && (typeof config.t3BaseDir!=='string'||!config.t3BaseDir)) throw new Error('Invalid T3 base directory');
  for(const binding of config.bindings) {
    if(binding.threadTargets===undefined) continue;
    if(!binding.threadTargets || typeof binding.threadTargets!=='object' || Array.isArray(binding.threadTargets)) throw new Error('Invalid target mappings');
    for(const [source,target] of Object.entries(binding.threadTargets)) {
      validateThreadId(source);
      if(!target || target.kind!=='t3' || !config.t3Command) throw new Error('Unsupported agent target');
      validateThreadId(target.threadId);
    }
  }
}

export function targetFor(binding, source) {
  return source && Object.hasOwn(binding.threadTargets ?? {},source) ? structuredClone(binding.threadTargets[source]) : undefined;
}

export function inspectAgentTarget(options, dependencies) {
  if(options.agentTarget) {
    if(options.agentTarget.kind!=='t3') throw new Error('Unsupported agent target');
    return inspectT3Target({...options,threadId:options.agentTarget.threadId},dependencies);
  }
  return inspectTarget(options,dependencies);
}

export function sendAgent(options, dependencies) {
  if(options.agentTarget) {
    if(options.agentTarget.kind!=='t3') throw new Error('Unsupported agent target');
    return sendT3(options,dependencies);
  }
  return sendCodex(options,dependencies);
}
