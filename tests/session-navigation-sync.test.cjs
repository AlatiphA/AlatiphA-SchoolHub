const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app-4.js','utf8'),client=fs.readFileSync('sync-client.js','utf8'),fees=fs.readFileSync('fees.js','utf8');
const nav=app.slice(app.indexOf('const NAV_VIEW_KEY'),app.indexOf('function refreshHeadTeacherSelect()'));
const recovery=app.slice(app.indexOf('async function revalidateAndSyncAfterReconnect('),app.indexOf('function setLastSyncedNow()'));
const background=app.slice(app.indexOf('async function runSchoolHubBackgroundSync('),app.indexOf("if (typeof window !== 'undefined') window.runSchoolHubBackgroundSync"));
function fixture(){
 const writes=[],events=[],local=new Map([['arc_last_view','fees']]);
 const c={setTimeout,clearTimeout,console:{warn(){}},navigator:{onLine:true},FIREBASE_ENABLED:true,currentUid:'u',currentSchoolId:'s',currentStatus:'active',currentRole:'headTeacher',sessionGeneration:1,sessionReady:true,sessionDataReady:true,offlineAuthenticatedMode:true,offlineReconnectInProgress:false,cloudHydrationInProgress:false,
 localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)},updateOfflineModeBanner(){},isCurrentSession:(t,u,s)=>t===c.sessionGeneration&&u===c.currentUid&&s===c.currentSchoolId,
 isLikelyOfflineError:e=>e.code==='unavailable'||e.code==='schoolhub/deadline-exceeded',flushPendingCloudWrites:async()=>writes.push('primary'),pullCloudData:async()=>events.push('pull'),saveVerifiedLocalSession(){},clearVerifiedLocalSession(){events.push('clear-verified');},getSavedNavigation:()=>({view:'fees'}),showView:v=>events.push(v),startBackgroundImageSync(){},hasPendingSchoolHubSync:()=>false,requestSchoolHubBackgroundSync:async()=>{},window:{flushPendingSchoolFeeWrites:async()=>writes.push('fees')}};
 for(const name of ['loadSettingsForm','refreshProfileMenu','renderHome','renderClasses','renderStudents','renderSubjects','renderStaff','renderQuickAccessList','hideSessionRestoring','hideSyncingMessage','hideAuthGate','hideDisabledGate','showPendingGate','hidePendingGate','showSchoolChoiceGate','showDisabledGate','resetWorkspaceState','renderAuthForm','showAuthGate','setAuthError'])c[name]=()=>events.push(name);
 const user={uid:'u',email:'teacher@example.test',getIdToken:async()=>events.push('token')};
 let reads=0,member={status:'active',schoolId:'s',role:'headTeacher',email:user.email};
 c.firebase={auth:()=>({currentUser:user}),firestore:()=>({collection:()=>({doc:()=>({get:async()=>{reads++;return {exists:true,data:()=>member};}})})})};
 vm.createContext(c);vm.runInContext('let reconnectTask=null;'+recovery+background,c);
 return {c,writes,events,user,local,setMember:x=>member=x,reads:()=>reads};
}
test('every supported view survives refresh including Fees and Billing',()=>{
 const c={localStorage:{getItem:k=>k==='arc_last_view'?c.page:'analysis'}};vm.createContext(c);vm.runInContext(nav,c);
 for(const page of vm.runInContext('views',c)){c.page=page;assert.equal(c.getSavedNavigation().view,page);}
 c.page='unknown';assert.equal(c.getSavedNavigation().view,'home');
});
test('temporary startup Home cannot overwrite the saved Fees page',()=>{
 const store=new Map([['arc_last_view','fees']]),c={sessionDataReady:false,localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}};vm.createContext(c);vm.runInContext(nav,c);c.saveNavigationState('home');assert.equal(c.getSavedNavigation().view,'fees');
});
test('overlapping recovery callers wait for token refresh and one membership check',async()=>{
 const f=fixture();let release;f.user.getIdToken=()=>new Promise(r=>release=r);
 const a=f.c.runSchoolHubBackgroundSync('app-visible'),b=f.c.runSchoolHubBackgroundSync('online');await Promise.resolve();assert.equal(f.writes.length,0);release();await Promise.all([a,b]);assert.equal(f.reads(),1);assert.equal(f.writes.filter(x=>x==='primary').length,1);assert(f.events.indexOf('pull')>=0);assert.equal(f.c.offlineReconnectInProgress,false);
});
test('thirty offline/reconnect cycles retain page and upload only after verification',async()=>{
 const f=fixture();for(let i=0;i<30;i++){f.c.navigator.onLine=false;f.c.offlineAuthenticatedMode=true;const count=f.writes.length;assert.equal(await f.c.runSchoolHubBackgroundSync('online'),false);assert.equal(f.writes.length,count);f.c.navigator.onLine=true;assert.equal(await f.c.runSchoolHubBackgroundSync('online'),true);assert.equal(f.events.at(-1),'fees');}assert.equal(f.reads(),30);
});
test('return from idle rechecks membership even when offline event was missed',async()=>{
 const f=fixture();f.c.offlineAuthenticatedMode=false;await f.c.runSchoolHubBackgroundSync('app-visible');assert.equal(f.reads(),1);assert.equal(f.events[0],'token');
});
test('resume during initial hydration cannot mark cached school data ready or upload',async()=>{
 const f=fixture();f.c.sessionDataReady=false;f.c.cloudHydrationInProgress=true;await f.c.runSchoolHubBackgroundSync('app-visible');await f.c.revalidateAndSyncAfterReconnect();assert.equal(f.reads(),0);assert.equal(f.writes.length,0);assert.equal(f.c.sessionDataReady,false);assert.equal(f.c.cloudHydrationInProgress,true);
});
test('failed token refresh retains queued work and next wake recovers',async()=>{
 const f=fixture();f.user.getIdToken=async()=>{throw Object.assign(Error('network'),{code:'unavailable'});};assert.equal(await f.c.runSchoolHubBackgroundSync('online'),false);assert.equal(f.writes.length,0);assert.equal(f.c.offlineReconnectInProgress,false);f.user.getIdToken=async()=>{};assert.equal(await f.c.runSchoolHubBackgroundSync('foreground-retry'),true);assert.deepEqual(f.writes,['primary','fees']);
});
test('hung verification times out, releases recovery and ignores its late result',async()=>{
 const f=fixture();let timeout,late;f.c.setTimeout=fn=>{timeout=fn;return 1;};f.c.clearTimeout=()=>{};f.user.getIdToken=()=>new Promise(r=>late=r);
 const p=f.c.runSchoolHubBackgroundSync('app-visible');timeout();await p;assert.equal(f.c.offlineReconnectInProgress,false);assert.equal(f.writes.length,0);
 late();await Promise.resolve();assert.equal(f.reads(),0);f.user.getIdToken=async()=>{};await f.c.runSchoolHubBackgroundSync('foreground-retry');assert.deepEqual(f.writes,['primary','fees']);
});
test('expired or revoked refresh credentials require login without sending pending saves',async()=>{
 const f=fixture();f.user.getIdToken=async()=>{throw Object.assign(Error('expired'),{code:'auth/user-token-expired'});};await f.c.runSchoolHubBackgroundSync('app-focus');assert.equal(f.writes.length,0);assert.equal(f.c.sessionReady,false);assert(f.events.includes('showAuthGate'));assert(f.events.includes('clear-verified'));
});
test('disabled membership after idle blocks primary and fee uploads',async()=>{
 const f=fixture();f.setMember({status:'disabled',schoolId:'s'});await f.c.runSchoolHubBackgroundSync('app-visible');assert.equal(f.writes.length,0);assert.equal(f.c.sessionReady,false);assert(f.events.includes('showDisabledGate'));
});
test('account switch during token refresh cannot flush old data or mutate new session',async()=>{
 const f=fixture();let release;f.user.getIdToken=()=>new Promise(r=>release=r);const p=f.c.runSchoolHubBackgroundSync('online');f.c.sessionGeneration++;f.c.currentUid='other';release();await p;assert.equal(f.writes.length,0);assert.equal(f.reads(),0);
});
test('visible retry works without native Background Sync; hidden pages do not poll',async()=>{
 const listeners={},calls=[],c={document:{visibilityState:'visible',addEventListener:(n,fn)=>listeners[n]=fn},window:{addEventListener:(n,fn)=>listeners[n]=fn},navigator:{onLine:true},currentUid:'u',sessionReady:true,offlineAuthenticatedMode:false,hasPendingSchoolHubSync:()=>true,runSchoolHubBackgroundSync:async s=>calls.push(s),setInterval:fn=>c.tick=fn};vm.createContext(c);vm.runInContext(client,c);
 c.tick();listeners.focus();listeners.pageshow({persisted:true});await Promise.resolve();assert.deepEqual(calls,['foreground-retry','app-focus','app-resume']);c.document.visibilityState='hidden';c.tick();assert.equal(calls.length,3);
});
test('fee queue remains untouched while account recovery is pending',async()=>{
 const queue=JSON.stringify([{request:{requestId:'payment-1'}}]),c={navigator:{onLine:true},offlineAuthenticatedMode:true,feeWithLock:async(_,fn)=>fn(),feeQueueRead:()=>JSON.parse(queue),safetyCall:async()=>assert.fail('unverified payment must not send'),localStorage:{setItem:()=>assert.fail('queue must stay saved')}};vm.createContext(c);vm.runInContext(fees.slice(fees.indexOf('async function feeFlush'),fees.indexOf('function feeCash')),c);await c.feeFlush('fees',()=>true);
});
test('brief focus and dialog returns reuse recent verification without another recovery pull',async()=>{
 const f=fixture();await f.c.runSchoolHubBackgroundSync('online');const reads=f.reads(),pulls=f.events.filter(x=>x==='pull').length;
 for(const source of ['app-focus','app-visible','app-resume','foreground-retry','app-focus'])await f.c.runSchoolHubBackgroundSync(source);
 assert.equal(f.reads(),reads);assert.equal(f.events.filter(x=>x==='pull').length,pulls);assert.equal(f.c.offlineAuthenticatedMode,false);
});
test('offline boundary and expired or foreign verification always require membership checks',async()=>{
 const f=fixture();await f.c.runSchoolHubBackgroundSync('online');
 f.c.offlineAuthenticatedMode=true;await f.c.runSchoolHubBackgroundSync('app-focus');assert.equal(f.reads(),2);
 f.c.revalidateAndSyncAfterReconnect.verifiedContext.at=Date.now()-300001;await f.c.runSchoolHubBackgroundSync('app-focus');assert.equal(f.reads(),3);
 f.c.revalidateAndSyncAfterReconnect.verifiedContext.uid='other';await f.c.runSchoolHubBackgroundSync('app-visible');assert.equal(f.reads(),4);
});

test('healthy expired desktop verification is marked as a routine check and still gates all writes',async()=>{
 const f=fixture();f.c.offlineAuthenticatedMode=false;let release;f.user.getIdToken=()=>new Promise(r=>release=r);const p=f.c.runSchoolHubBackgroundSync('app-visible');assert.equal(f.c.performReconnectRecovery.startedOffline,false);assert.equal(f.c.offlineAuthenticatedMode,true);assert.equal(f.writes.length,0);release();await p;assert.equal(f.reads(),1);assert(f.events.includes('pull'));assert.equal(f.c.offlineAuthenticatedMode,false);
});
test('offline boundary marks recovery as reconnecting before account verification',async()=>{
 const f=fixture();await f.c.runSchoolHubBackgroundSync('online');assert.equal(f.c.performReconnectRecovery.startedOffline,true);assert.equal(f.reads(),1);
});

test('repeated fast retries share in-flight verification and never upload early',async()=>{
 const f=fixture();let release;f.user.getIdToken=()=>new Promise(r=>release=r);
 const retries=Array.from({length:4},()=>f.c.runSchoolHubBackgroundSync('foreground-retry'));
 assert.equal(f.writes.length,0);assert.equal(f.reads(),0);release();await Promise.all(retries);
 assert.equal(f.reads(),1);assert.equal(f.writes.filter(x=>x==='primary').length,1);assert.equal(f.c.offlineAuthenticatedMode,false);
});

test('verified recovery retains the current editable grade sheet instead of rebuilding it',async()=>{const f=fixture();f.c.getSavedNavigation=()=>({view:'grades'});let retained=0;f.c.preserveLiveGradeSheetAfterRecovery=()=>{retained++;return true;};await f.c.performReconnectRecovery();assert.equal(retained,1);assert.equal(f.reads(),1);assert(f.events.includes('pull'));assert(!f.events.includes('grades'));});
test('changed grade context still takes the normal page rendering path after recovery',async()=>{const f=fixture();f.c.getSavedNavigation=()=>({view:'grades'});f.c.preserveLiveGradeSheetAfterRecovery=()=>false;await f.c.performReconnectRecovery();assert(f.events.includes('grades'));assert.equal(f.reads(),1);});
