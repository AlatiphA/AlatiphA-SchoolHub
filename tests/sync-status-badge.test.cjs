const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
function fixture(){
 const badge={dataset:{},classList:{toggle(){}},setAttribute(){}},title={},detail={};
 const banner={classList:{toggle(){}},querySelector:s=>s==='.offline-mode-title'?title:detail};
 const ctx={document:{getElementById:id=>id==='syncStatusBtn'?badge:banner},navigator:{onLine:true},currentSchoolId:'school',currentStatus:'active',sessionDataReady:true,offlineAuthenticatedMode:false,offlineReconnectInProgress:false,pending:0,syncErrors:new Map(),syncableFields:()=>[{key:'students'}]};
 ctx.pendingSyncCountForCurrentSchool=()=>ctx.pending;vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function updateOfflineModeBanner('),source.indexOf('function startCachedAuthenticatedSession(')),ctx);return {ctx,badge,title,detail};
}
test('header status distinguishes clean, sending, failed and offline records',()=>{
 const {ctx,badge}=fixture();ctx.updateOfflineModeBanner();assert.equal(badge.textContent,'Up to date');
 ctx.pending=3;ctx.updateOfflineModeBanner();assert.equal(badge.textContent,'3 syncing');
 ctx.syncErrors.set('students',true);ctx.updateOfflineModeBanner();assert.equal(badge.textContent,'3 unsynced');
 ctx.navigator.onLine=false;ctx.updateOfflineModeBanner();assert.equal(badge.textContent,'3 pending');
 ctx.pending=0;ctx.updateOfflineModeBanner();assert.equal(badge.textContent,'Offline');
});
test('status does not claim up to date while account data is loading',()=>{
 const {ctx,badge}=fixture();ctx.sessionDataReady=false;ctx.updateOfflineModeBanner();assert.equal(badge.textContent,'Checking…');
});
