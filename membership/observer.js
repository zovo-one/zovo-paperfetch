import './eligibility.js';
const api=globalThis.ZovoSubscriptionMembership;
// Updated synchronously on oldValue before any asynchronous persistence begins.
let member=false,recovery=false,readFailed=false,trialUntil=0;
let queue=Promise.resolve();
function capture(bag){const kind=api.subscriptionKind(bag);if(kind==='free')return false;if(kind==='member')member=true;else if(kind==='trial')trialUntil=Math.max(trialUntil,typeof bag?.trialExpires==='number'?bag.trialExpires:0);else recovery=true;return true;}
async function persist(){const flags={};if(member)flags[api.MEMBER]=true;if(recovery)flags[api.RECOVERY]=true;if(trialUntil>0)flags[api.TRIAL]=trialUntil;if(!Object.keys(flags).length)return;
 let durable=false;try{await chrome.storage.local.set(flags);durable=true;}catch{readFailed=true;}
 // Session fallback survives service-worker suspension when local persistence fails.
 try{await chrome.storage.session.set(flags);}catch{if(!durable)readFailed=true;}
}
function schedule(){queue=queue.then(persist).catch(()=>{readFailed=true;});}
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;
 if(typeof changes[api.TRIAL]?.newValue==='number'&&Number.isFinite(changes[api.TRIAL].newValue))trialUntil=Math.max(trialUntil,changes[api.TRIAL].newValue);
 if(changes[api.MEMBER]?.newValue===true)member=true;if(changes[api.RECOVERY]?.newValue===true)recovery=true;
 let touched=false;for(const key of api.LICENSE_KEYS){const change=changes[key];if(!change)continue;if(change.oldValue!==undefined&&capture({[key]:change.oldValue}))touched=true;if(change.newValue!==undefined&&capture({[key]:change.newValue}))touched=true;}
 if(touched)schedule();
});
const initialized=(async()=>{try{const data=await chrome.storage.local.get([...api.LICENSE_KEYS,api.CAMPAIGN,api.MEMBER,api.RECOVERY,api.TRIAL]);if(data[api.TRIAL]!==undefined){if(typeof data[api.TRIAL]==='number'&&Number.isFinite(data[api.TRIAL]))trialUntil=Math.max(trialUntil,data[api.TRIAL]);else readFailed=true;}member=member||data[api.MEMBER]===true||data[api.CAMPAIGN]?.memberSeen===true;recovery=recovery||data[api.RECOVERY]===true||data[api.CAMPAIGN]?.recoverySeen===true;capture(api.pick(data));}catch{readFailed=true;}
try{const data=await chrome.storage.session.get([api.MEMBER,api.RECOVERY,api.TRIAL]);if(data[api.TRIAL]!==undefined){if(typeof data[api.TRIAL]==='number'&&Number.isFinite(data[api.TRIAL]))trialUntil=Math.max(trialUntil,data[api.TRIAL]);else readFailed=true;}member=member||data[api.MEMBER]===true;recovery=recovery||data[api.RECOVERY]===true;}catch{readFailed=true;}schedule();})();
async function status(){await initialized;try{const data=await chrome.storage.local.get(api.LICENSE_KEYS);if(capture(api.pick(data)))schedule();}catch{readFailed=true;}
// Do not wait for potentially delayed writes: the volatile guard already has the result.
return member?'member':recovery||readFailed?'unknown':trialUntil>Date.now()?'trial':'free';}
chrome.runtime.onConnect.addListener(port=>{if(port.name!==api.PORT)return;port.onMessage.addListener(message=>{if(message?.request!=='status')return;void status().then(value=>{try{port.postMessage({campaign:api.CAMPAIGN,status:value});}catch{}});});});
