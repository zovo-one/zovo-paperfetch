(function(root){'use strict';
const LICENSE_KEYS=["pro", "licenseKey", "proExp"],CAMPAIGN="zovo.membership.paperfetch.v1",PRODUCT="PaperFetch",CARD="Keep finding papers. Help me keep improving PaperFetch.",DAYS30=30*86400000;

// PaperFetch keeps pro {active:boolean, verifiedAt:string|null}, licenseKey (string) and proExp (epoch ms) as separate local keys.
// active:true is a member. A downgraded cache that still carries verifiedAt, a retained key, or a positive proExp is unknown: suppress, never sell.
function subscriptionKind(bag){
 if(bag===undefined||bag===null)return 'free';
 if(typeof bag!=='object'||Array.isArray(bag))return 'unknown';
 const pro=bag.pro,key=bag.licenseKey,exp=bag.proExp;let evidence=false;
 if(pro!==undefined&&pro!==null){
  if(typeof pro!=='object'||Array.isArray(pro)||typeof pro.active!=='boolean')return 'unknown';
  if(pro.active===true)return 'member';
  if(pro.verifiedAt!==undefined&&pro.verifiedAt!==null){if(typeof pro.verifiedAt!=='string')return 'unknown';evidence=true;}
 }
 if(key!==undefined&&key!==null){if(typeof key!=='string')return 'unknown';if(key!=='')evidence=true;}
 if(exp!==undefined&&exp!==null){if(typeof exp!=='number'||!Number.isFinite(exp))return 'unknown';if(exp>0)evidence=true;}
 return evidence?'unknown':'free';
}

function pick(data){const bag={};let any=false;for(const key of LICENSE_KEYS){if(data&&Object.prototype.hasOwnProperty.call(data,key)&&data[key]!==undefined){bag[key]=data[key];any=true;}}return any?bag:undefined;}
function classify(bag,state,now){const kind=subscriptionKind(bag);if(kind!=='free')return kind;
 if(state!==undefined&&state!==null){if(typeof state!=='object'||Array.isArray(state))return 'unknown';if(state.memberSeen)return 'member';if(state.recoverySeen)return 'unknown';if(state.hidden===true)return 'dismissed';if(state.dismissedAt!==undefined&&(typeof state.dismissedAt!=='number'||!Number.isFinite(state.dismissedAt)))return 'unknown';if(state.dismissedAt&&now-state.dismissedAt<DAYS30)return 'dismissed';}return 'free';}
const MEMBER=CAMPAIGN+'.memberSeen',RECOVERY=CAMPAIGN+'.recoverySeen',TRIAL=CAMPAIGN+'.trialUntil',PORT=CAMPAIGN+'.status';
// Dedicated flags are monotonic and cannot be overwritten by a dismissal read-modify-write.
function requestWorkerStatus(){return new Promise(resolve=>{let port,done=false;const finish=status=>{if(done)return;done=true;clearTimeout(timer);try{port?.disconnect();}catch{}resolve(status);};const timer=setTimeout(()=>finish('unknown'),2500);try{port=chrome.runtime.connect({name:PORT});port.onMessage.addListener(message=>{finish(message&&message.campaign===CAMPAIGN&&['free','member','trial','unknown'].includes(message.status)?message.status:'unknown');});port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;finish('unknown');});port.postMessage({request:'status'});}catch{finish('unknown');}});}
async function read(){try{const data=await chrome.storage.local.get([...LICENSE_KEYS,CAMPAIGN,MEMBER,RECOVERY,TRIAL]);const localKind=classify(pick(data),data[CAMPAIGN],Date.now());if(data[MEMBER]===true)return 'member';if(data[RECOVERY]===true)return 'unknown';if(data[TRIAL]!==undefined&&(typeof data[TRIAL]!=='number'||!Number.isFinite(data[TRIAL])))return 'unknown';if(data[TRIAL]>Date.now())return 'trial';const workerKind=await requestWorkerStatus();if(workerKind!=='free')return workerKind;return localKind;}catch{return 'unknown';}}
async function dismiss(forever){const data=await chrome.storage.local.get(CAMPAIGN);await chrome.storage.local.set({[CAMPAIGN]:{...(data[CAMPAIGN]||{}),dismissedAt:Date.now(),hidden:forever===true}});}
// Page-side capture: persist prior membership from oldValue before any product refresh can erase it, independent of the worker.
function watch(){try{chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;const flags={};for(const key of LICENSE_KEYS){const change=changes[key];if(!change)continue;for(const value of [change.oldValue,change.newValue]){if(value===undefined)continue;const kind=subscriptionKind({[key]:value});if(kind==='member')flags[MEMBER]=true;else if(kind==='unknown')flags[RECOVERY]=true;}}if(Object.keys(flags).length){chrome.storage.local.set(flags).catch(()=>{});}});}catch{}}
root.ZovoSubscriptionMembership={LICENSE_KEYS,CAMPAIGN,PRODUCT,CARD,classify,subscriptionKind,pick,read,dismiss,watch,MEMBER,RECOVERY,TRIAL,PORT};
})(globalThis);
