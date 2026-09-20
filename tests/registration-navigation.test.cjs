const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app-4.js','utf8');
const handlers = new Map();
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) {
    const classes = new Set();
    nodes.set(id, { value: 'New school', textContent: '', addEventListener: (type,fn) => handlers.set(id,fn),
      classList: {toggle: (key,on) => on ? classes.add(key) : classes.delete(key), add:key=>classes.add(key), contains:key=>classes.has(key)} });
  }
  return nodes.get(id);
}
let finishUpload;
let opened = false;
let gateHidden = false;
const context = vm.createContext({document:{getElementById:node},
  registerSchool: async()=> 'ABC-123', pushAllFieldsNow: ()=> new Promise(resolve=>{finishUpload=resolve;}),
  hideSchoolChoiceGate:()=>{}, hideSyncingMessage:()=>{}, hideAuthGate:()=>{gateHidden=true;},
  initLockScreen:()=>{}, proceedToApp:()=>{opened=true;}, renderQuickAccessList:()=>{},refreshProfileMenu:()=>{},
  alert:()=>{}, console, isCurrentSession:()=>true, setSchoolChoiceError:message=>{throw Error(message);},
  enforceGuestTrial:()=>true,isTeacher:()=>false,saveNavigationState:()=>{},
  renderHome:()=>{}, renderClasses:()=>{},renderStudents:()=>{},renderSubjects:()=>{},renderStaff:()=>{},renderFloatingPill:()=>{},showFloatingPill:()=>{},
  window:{scrollTo:()=>{}}
});
vm.runInContext(`let sessionGeneration=1,currentUid='new-user',currentSchoolId='new-school';
let sessionReady=false,sessionDataReady=false,appStarted=false;
const FIREBASE_ENABLED=true;
const views=['home','setup'];`,context);
const begin = source.indexOf("  document.getElementById('registerSchoolBtn').addEventListener");
const end = source.indexOf("  document.getElementById('joinSchoolBtn').addEventListener",begin);
vm.runInContext(source.slice(begin,end),context);
const viewStart = source.indexOf('function showView(');
vm.runInContext(source.slice(viewStart,source.indexOf('\n}',viewStart)+2),context);
const backStart=source.indexOf("document.getElementById('backBtn').addEventListener");
vm.runInContext(source.slice(backStart,source.indexOf('\n',backStart)),context);
(async()=>{
  handlers.get('registerSchoolBtn')();
  await Promise.resolve();
  assert.equal(opened,true,'workspace opens before upload resolves');
  assert.equal(gateHidden,true);
  assert.equal(vm.runInContext('sessionReady && sessionDataReady',context),true);
  assert.equal(typeof finishUpload,'function','upload is still pending');
  handlers.get('backBtn')();
  assert.equal(node('view-home').classList.contains('hidden'),false,'Back opens Home while upload is pending');
  assert.equal(node('view-setup').classList.contains('hidden'),true);
  assert.equal(node('brandText').textContent,'AlatiphA SchoolHub');
  finishUpload();
  console.log('Registration navigation passed: Home is reachable before the initial cloud upload completes.');
})().catch(error=>{console.error(error);process.exitCode=1;});
