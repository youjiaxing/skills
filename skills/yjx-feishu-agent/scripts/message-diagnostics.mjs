import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
export function messageRequestId(appId,messageId) { return `fs-${hash(`${appId}:${messageId}`)}`; }
export function safeFailure(error, stage) {
  return {stage,code:'OPERATION_UNCONFIRMED',
    ...(Number.isSafeInteger(error?.apiCode) ? {apiCode:error.apiCode} : {}),
    ...(Number.isSafeInteger(error?.httpStatus) ? {httpStatus:error.httpStatus} : {}),
  };
}
export async function recordAdmission({stateDir,appId},messageId,reason) {
  const directory=path.join(stateDir,'feishu',hash(appId),'admissions');
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,`${messageRequestId(appId,messageId)}.json`),temporary=`${file}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify({messageId,reason,observedAt:new Date().toISOString()}),{mode:0o600});
  await rename(temporary,file);
}
async function read(file) {
  try { return {value:JSON.parse(await readFile(file,'utf8'))}; }
  catch(error) { return {state:error.code==='ENOENT' ? 'not_observed' : 'unreadable'}; }
}
export async function diagnoseMessage({stateDir,appId,messageId}) {
  const requestId=messageRequestId(appId,messageId),root=path.join(stateDir,'feishu',hash(appId));
  const [task,admission,feedback,execution]=await Promise.all([
    ...['messages','admissions','feedback'].map(name=>read(path.join(root,name,`${requestId}.json`))),
    read(path.join(stateDir,'requests',requestId,'record.json')),
  ]);
  const record=task.value,marker=feedback.value;
  return {messageId,requestId,readOnly:true,
    admission:record ? {state:'accepted',createdAt:record.createdAt} : admission.value ?? {state:admission.state},
    task:record ? {status:record.status,stage:record.stage,failure:record.failure} : {state:task.state},
    route:record ? {state:record.routeError ? 'blocked' : record.threadId ? 'selected' : 'unknown',
      code:record.routeCode,threadId:record.threadId} : {state:task.state},
    codex:record ? {status:record.codexStatus ?? 'not_observed',submitted:record.codexSubmitted ?? null,code:record.codexCode,
      waitMode:record.waitMode,rpcTimeoutMs:record.codexRpcTimeoutMs,
      timeoutMs:record.codexTimeoutMs,waitTimedOut:record.waitTimedOut,interruptRequested:record.interruptRequested} : {state:task.state},
    execution:execution.value ? {status:execution.value.status,turnId:execution.value.turnId,
      waitMode:execution.value.waitMode,submitted:execution.value.submitted,
      observationState:execution.value.observationState,lastObservedAt:execution.value.lastObservedAt,
      lastProgressAt:execution.value.lastProgressAt,lastObservationError:execution.value.lastObservationError,
    } : {state:execution.state},
    reply:record ? {state:record.replyMessageId ? 'confirmed' : record.replyAttempted ? 'unknown' : 'not_attempted',
      messageId:record.replyMessageId,failureMessageId:record.failureReplyMessageId} : {state:task.state},
    feedback:marker ? {desired:marker.desired,attempts:marker.attempts,lastWarning:marker.lastWarning} : {state:feedback.state},
  };
}
