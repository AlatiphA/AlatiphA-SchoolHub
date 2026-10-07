const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function notificationFixture(search=''){
 const app=fs.readFileSync('app-4.js','utf8'),listeners=[],elements=new Map();
 const element=()=>({textContent:'',classList:{toggle(){},add(){},remove(){}},innerHTML:''});
 const ctx={currentUid:'one',FIREBASE_ENABLED:true,Notification:{permission:'denied'},localStorage:{getItem(){throw Error('Storage unavailable');}},URL,URLSearchParams,
  window:{location:{search,href:'https://example.test/'+search},history:{state:null,replaceState(){}}},
  navigator:{},console:{warn(){}},document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);}},
  firebase:{auth:()=>({currentUser:{uid:ctx.currentUid}}),firestore:()=>({collection:()=>({doc:()=>({collection:()=>({orderBy:()=>({limit:()=>({onSnapshot(options,next,error){listeners.push({next,error});return ()=>{};}})})})})})})}
 };
 vm.createContext(ctx);
 const start=app.indexOf('const SCHOOLHUB_BROWSER_NOTIFICATIONS_KEY'),end=app.indexOf('/* ---------- end Notifications / Communication v1 ---------- */',start);
 vm.runInContext(app.slice(start,end),ctx);ctx.renderNotificationCenter=()=>{};
 return {ctx,listeners,run:code=>vm.runInContext(code,ctx)};
}
test('denied or unavailable browser notification preferences do not disable the in-app bell',()=>{
 const f=notificationFixture();assert.equal(f.ctx.browserNotificationsEnabled(),false);
 f.ctx.Notification.permission='granted';assert.equal(f.ctx.browserNotificationsEnabled(),false);
 assert.doesNotThrow(()=>f.ctx.updateNotificationBadge());
});
test('old notification listener cannot populate another account after switching users',()=>{
 const f=notificationFixture();f.ctx.startNotificationListener({uid:'one'});f.ctx.currentUid='two';f.ctx.startNotificationListener({uid:'two'});
 f.listeners[0].next({docs:[{id:'private',data:()=>({body:'old account'})}],docChanges:()=>[]});
 assert.equal(f.run('notificationItems.length'),0);
 f.listeners[1].next({docs:[{id:'new',data:()=>({body:'new account'})}],docChanges:()=>[]});
 assert.equal(f.run('notificationItems[0].id'),'new');
});
test('listener errors permit a retry and opening a notification link consumes the link once',()=>{
 const f=notificationFixture('?notifications=1');let opened=0;f.ctx.showNotificationCenter=()=>opened++;
 f.ctx.startNotificationListener({uid:'one'});assert.equal(opened,1);
 f.listeners[0].error(Error('temporarily unavailable'));assert.equal(f.run('notificationListenerStarted'),false);
 f.ctx.startNotificationListener({uid:'one'});assert.equal(f.listeners.length,2);assert.equal(opened,1);
});

test('cache-to-server startup populates old notices without replaying phone alerts',()=>{const f=notificationFixture(),shown=[];f.ctx.showSchoolHubBrowserNotification=x=>shown.push(x.id);f.ctx.startNotificationListener({uid:'one'});const emit=(records,fromCache)=>f.listeners[0].next({metadata:{fromCache},docs:records.map(x=>({id:x.id,data:()=>x})),docChanges:()=>records.map(x=>({type:'added',doc:{id:x.id,data:()=>x}}))});emit([],true);emit([{id:'old'}],false);assert.equal(shown.length,0);emit([{id:'fresh'}],false);assert.deepEqual(shown,['fresh']);});

test('already-read notification cannot create a phone alert',async()=>{const f=notificationFixture();f.ctx.Notification.permission='granted';f.ctx.localStorage.getItem=()=> '1';f.ctx.document.visibilityState='hidden';let alerts=0;f.ctx.navigator.serviceWorker={ready:Promise.resolve({showNotification:()=>alerts++})};assert.equal(await f.ctx.showSchoolHubBrowserNotification({id:'old',read:true}),false);assert.equal(alerts,0);});
function feeHelpers(){const ctx={navigator:{},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},Map,Set,Promise};vm.createContext(ctx);vm.runInContext(fs.readFileSync('fees.js','utf8').split('window.addEventListener')[0],ctx);return ctx;}
test('client allocation lists keep test and production ledgers separate and reject excessive amounts',()=>{
 const c=feeHelpers(),charges=[{id:'real',baseAmount:100,paid:0},{id:'test',baseAmount:100,paid:0,isTestData:true}];
 assert.deepEqual(Array.from(c.feePaymentCharges(charges),x=>x.id),['real']);
 assert.deepEqual(Array.from(c.feePaymentCharges(charges,true),x=>x.id),['test']);
 assert.throws(()=>c.feeCents('99999999999999999999999999999'),/too large/);
});
function serverFixture(){
 const source=fs.readFileSync('functions/fees-v2.test.js','utf8'),body=source.slice(source.indexOf('function fixture(){'),source.indexOf('\nconst rid='));
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 return new Function('register','HttpsError',body+'\nreturn fixture();')(require('../functions/fees').register,HttpsError);
}
function seed(f){
 for(const [id,isTestData,year] of [['real',false,'2026/2027'],['test',true,'2025/2026']])f.records.set('schools/s/pupilCharges/'+id,{studentId:'p1',studentName:'Ama',classId:'c1',baseAmount:10000,paid:0,revision:0,isTestData,year,term:'Term 1'});
 f.records.set('schools/s/feeAccounts/legacy-test',{studentId:'p2',base:8000,paid:0,isTestData:true,year:'2025/2026',term:'Term 1'});
}
const payment={action:'recordPayment',requestId:'audit-payment-0001',studentId:'p1',amount:5000,method:'Cash',payer:'Parent'};
test('server default payments and report balances exclude synthetic charges including legacy records',async()=>{
 const f=serverFixture();seed(f);
 const r=await f.handlers.updateSchoolFees(f.req(payment));assert.equal(r.payment.allocations[0].chargeId,'real');assert.equal(r.payment.isTestData,false);
 const balances=await f.handlers.getReportFeeBalances(f.req({classId:'c1',year:'2026/2027',term:'Term 3'}));assert.equal(balances.balances.p1,5000);assert.equal(balances.balances.p2,undefined);
 const overview=await f.handlers.getSchoolFees(f.req({}));assert.equal(overview.arrears.reduce((n,r)=>n+r.balance,0),5000);
});
test('explicit test payments remain marked test and cannot manually allocate into production',async()=>{
 const f=serverFixture();seed(f);
 const r=await f.handlers.updateSchoolFees(f.req({...payment,isTestData:true}));assert.equal(r.payment.allocations[0].chargeId,'test');assert.equal(r.payment.isTestData,true);
 await assert.rejects(f.handlers.updateSchoolFees(f.req({...payment,requestId:'audit-payment-0002',isTestData:true,allocationMode:'manual',allocations:[{chargeId:'real',amount:5000}]})),e=>e.code==='failed-precondition');
});
test('legacy payment compatibility cannot allocate production money to older synthetic fees',async()=>{
 const f=serverFixture(),{key}=require('../functions/fees'),real=key('Term 1','2026/2027','p1'),synthetic=key('Term 1','2025/2026','p1');
 f.records.set('schools/s/feeAccounts/'+real,{studentId:'p1',base:10000,paid:0,term:'Term 1',year:'2026/2027',studentName:'Ama',className:'Class 1'});
 f.records.set('schools/s/feeAccounts/'+synthetic,{studentId:'p1',base:10000,paid:0,term:'Term 1',year:'2025/2026',isTestData:true});
 const result=await f.handlers.updateSchoolFees(f.req({...payment,action:'payment',accountId:real}));
 assert.equal(result.payment.allocations[0].accountId,real);assert.equal(result.payment.isTestData,false);assert.equal(f.records.get('schools/s/feeAccounts/'+synthetic).paid,0);
 await assert.rejects(f.handlers.updateSchoolFees(f.req({...payment,action:'payment',accountId:synthetic,requestId:'audit-legacy-0002'})),e=>e.code==='failed-precondition');
});
