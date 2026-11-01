const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
function fixture(open){let observer,refreshes=0,queued=[];const menu={classList:{contains:()=>!open}};const c={document:{getElementById:()=>menu},MutationObserver:class{constructor(fn){this.fn=fn;observer=this;}observe(){}disconnect(){this.disconnected=true;}},setTimeout:fn=>queued.push(fn)};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function refreshAfterReconnectWhenMenuCloses('),source.indexOf('async function performReconnectRecovery()')),c);return {c,run:()=>c.refreshAfterReconnectWhenMenuCloses(()=>refreshes++),close:()=>{open=false;observer.fn();},flush:()=>queued.splice(0).forEach(fn=>fn()),count:()=>refreshes,observer:()=>observer};}
test('recovery leaves open profile menu alone and refreshes after the selected action completes',()=>{const f=fixture(true);f.run();assert.equal(f.count(),0);f.close();assert.equal(f.count(),0);f.flush();assert.equal(f.count(),1);assert.equal(f.observer().disconnected,true);});
test('closed menu refreshes immediately and newer recovery replaces deferred work',()=>{const f=fixture(false);f.run();assert.equal(f.count(),1);const g=fixture(true);g.run();const old=g.observer();g.run();assert.equal(old.disconnected,true);g.close();g.flush();assert.equal(g.count(),1);});
test('routine recovery preserves view and scroll with role and session checks',()=>{const body=source.slice(source.indexOf('async function performReconnectRecovery()'),source.indexOf('function hideSyncingMessage()'));assert.ok(body.includes('window.scrollTo(scrollX, scrollY)'));assert.ok(body.includes("showView('home'); // A changed role"));assert.ok(body.includes('if (!isCurrentSession(token, uidBefore, schoolBefore)) return;'));assert.ok(!body.includes('showView(restored.view)'));});
test('repeated authentication notifications retain an open verified account but never reuse a different session',async()=>{
 const calls=[],c={currentUid:'u',currentSchoolId:'s',currentStatus:'active',sessionReady:true,sessionDataReady:true,runSchoolHubBackgroundSync:async source=>calls.push(source),console};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function resumeExistingSchoolHubSession('),source.indexOf('function refreshAfterReconnectWhenMenuCloses(')),c);
 assert.equal(c.resumeExistingSchoolHubSession({uid:'u'}),true);assert.deepEqual(calls,['auth-session-recheck']);
 for(const user of [null,{uid:'other'}])assert.equal(c.resumeExistingSchoolHubSession(user),false);
 for(const [key,value] of [['currentSchoolId',null],['currentStatus','disabled'],['sessionReady',false],['sessionDataReady',false]]){const old=c[key];c[key]=value;assert.equal(c.resumeExistingSchoolHubSession({uid:'u'}),false);c[key]=old;}
 assert.equal(calls.length,1);
});
test('routine cloud pull retains workspace readiness while keeping the write barrier active',()=>{
 const start=source.indexOf('function pullCloudData('),end=source.indexOf('  cloudHydrationStatusError',start),prefix=source.slice(start,end);
 // Execute the real initialization up to the first external side effect.
 for(const background of [true,false]){const c={FIREBASE_ENABLED:true,currentSchoolId:'s',currentUid:'u',sessionGeneration:1,sessionDataReady:true,cloudHydrationInProgress:false,isCurrentSession:()=>true};vm.createContext(c);vm.runInContext(prefix+'return;}',c);c.pullCloudData(1,{background});assert.equal(c.sessionDataReady,background);assert.equal(c.cloudHydrationInProgress,true);}
 assert.ok(source.includes('await pullCloudData(token, { background: true });'));
});
