(function(){
 'use strict';
 let uid='',generation=0,access=null,settings=null,busy=false,request=null,bindChain=Promise.resolve();
 const $=id=>document.getElementById(id),text=(id,v)=>{if($(id))$(id).textContent=v;};
 const call=(name,data={})=>firebase.app().functions('africa-south1').httpsCallable(name)(data).then(r=>r.data);
 const choiceKey=id=>'schoolhub-push-choice-'+id;
 function choice(id=uid){try{return JSON.parse(localStorage.getItem(choiceKey(id))||'{}');}catch{return {};}}
 const active=(token,owner)=>generation===token&&uid===owner&&firebase.auth().currentUser?.uid===owner;
 function supported(){return isSecureContext&&'Notification' in window&&'PushManager' in window&&'serviceWorker' in navigator;}
 async function bind(owner){
  const pending=bindChain.then(async()=>{if(!('serviceWorker' in navigator))return;const r=await navigator.serviceWorker.ready,w=r.active;if(!w)return;await new Promise((resolve,reject)=>{const ch=new MessageChannel(),t=setTimeout(()=>{ch.port1.close();reject(Error('Update SchoolHub before enabling push.'));},3000);ch.port1.onmessage=e=>{clearTimeout(t);ch.port1.close();e.data?.ok?resolve():reject(Error('Device binding failed.'));};w.postMessage({type:'SCHOOLHUB_PUSH_BIND',uid:owner},[ch.port2]);});});bindChain=pending.catch(()=>{});return pending;
 }
 let sdkLoading;
 async function messaging(){
  if(!firebase.messaging){if(!sdkLoading)sdkLoading=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js';script.onload=resolve;script.onerror=()=>{sdkLoading=null;script.remove();reject(Error('Could not load push support. Check your connection.'));};document.head.append(script);});await sdkLoading;}
  if(!(await firebase.messaging.isSupported()))throw Error('Push is not supported in this browser.');
  if(!settings?.appId||!settings?.messagingSenderId)throw Error('The project owner needs to finish Push setup.');
  const name='schoolhub-push',config={...globalThis.FIREBASE_CONFIG,appId:settings.appId,messagingSenderId:settings.messagingSenderId};
  let app=firebase.apps.find(a=>a.name===name);if(app&&(app.options.appId!==config.appId||app.options.messagingSenderId!==config.messagingSenderId)){await app.delete();app=null;}
  const m=(app||firebase.initializeApp(config,name)).messaging();m.onMessage(()=>{});return m;
 }
 function renderDevice(){
  const on=choice().enabled===true;
  for(const id of ['notificationBrowserToggleBtn','shPushDeviceBtn'])if($(id)){$(id).disabled=busy||!uid||!supported()||Notification.permission==='denied';$(id).textContent=on?'Disable push on this device':'Enable push on this device';}
  const message=!uid?'Sign in to manage push.':!supported()?'Push is not supported on this device.':Notification.permission==='denied'?'Notifications are blocked. Allow them in browser site settings.':on?'Push is enabled on this device. Delivery depends on connection and browser settings.':settings&&!settings.enabled?'Push setup has not been enabled by the project owner. In-app messages still work.':'Enable alerts for this browser or installed app, including when SchoolHub is closed.';
  text('notificationBrowserStatus',message);text('shPushDeviceStatus',message);
 }
 async function register(token,owner){
  const m=await messaging();if(!active(token,owner))return;
  const worker=await navigator.serviceWorker.ready,deviceToken=await m.getToken({vapidKey:settings.publicKey,serviceWorkerRegistration:worker});if(!active(token,owner))return;
  const old=choice(owner),p={messages:$('shPushMessages')?.checked??old.preferences?.messages??true,activity:$('shPushActivity')?.checked??old.preferences?.activity??true};
  const r=await call('registerSchoolHubPushDevice',{ownerUid:owner,token:deviceToken,previousId:old.id||'',preferences:p});
  if(!active(token,owner)){await call('unregisterSchoolHubPushDevice',{ownerUid:owner,id:r.id}).catch(()=>{});return;}
  localStorage.setItem(choiceKey(owner),JSON.stringify({enabled:true,id:r.id,preferences:p}));await bind(owner);if(!active(token,owner))await bind(uid);
 }
 async function toggle(){
  if(busy||!uid||!supported())return;const owner=uid,token=generation;busy=true;renderDevice();
  try{
   const old=choice(owner);if(old.enabled){localStorage.removeItem(choiceKey(owner));await bind('');if(navigator.onLine===false)throw Error('Push stopped locally. Reconnect and disable browser notification permission to fully unregister.');await call('unregisterSchoolHubPushDevice',{ownerUid:owner,id:old.id});if(active(token,owner))await (await messaging()).deleteToken();}
   else{if(!settings?.enabled)throw Error('The project owner needs to enable Push setup first.');const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();if(permission!=='granted')throw Error('Notification permission was not granted.');if(active(token,owner))await register(token,owner);}
  }catch(e){if(active(token,owner)){text('shMessagingStatus',e.message);text('notificationBrowserStatus',e.message);}}
  finally{if(active(token,owner)){busy=false;renderDevice();}}
 }
 function makeUI(){if($('schoolHubMessagingDialog'))return;
  const wrapper=document.createElement('div');wrapper.innerHTML=`<div id="schoolHubMessagingDialog" class="sh-message-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="shMessagingTitle"><div class="sh-message-card"><header><h2 id="shMessagingTitle">Messages &amp; Push</h2><button type="button" id="shMessagingClose" aria-label="Close Messages and Push">×</button></header><nav class="sh-message-tabs" aria-label="Messaging controls"><button id="shMessagesTab" type="button" hidden>Messages</button><button id="shSetupTab" type="button" hidden>Push setup</button><button id="shDeviceTab" type="button">This device</button><button id="shOwnerSecurityTab" type="button" aria-label="Account Security" hidden>Security</button></nav><div class="sh-message-body"><p id="shMessagingStatus" role="status" aria-live="polite"></p>
  <section id="shDeviceSection"><h3>This device</h3><p id="shPushDeviceStatus"></p><label><input type="checkbox" id="shPushMessages" checked> Messages and announcements</label><label><input type="checkbox" id="shPushActivity" checked> School activity alerts</label><button type="button" id="shPushDeviceBtn">Enable push on this device</button><button type="button" id="shPushRefresh">Refresh device status</button><p id="shPushDiagnostics" class="hint"></p></section>
  <section id="shSendSection" hidden><h3>Messages</h3><p id="shSenderScope" class="hint"></p><form id="shMessageForm"><label id="shSchoolWrap">School<select id="shMessageSchool"><option value="">Unarchived schools · active Head Teachers and teachers</option></select></label><label>Recipient<select id="shMessageRecipient"><option value="">All active recipients</option></select></label><label>Title<input id="shMessageTitle" maxlength="160" required></label><label>Message<textarea id="shMessageBody" maxlength="1000" rows="4" required></textarea></label><button id="shMessageSend" type="submit">Review and send</button></form></section>
  <section id="shSetupSection" hidden><h3>Push setup</h3><p class="hint">Project owner only. Use the public values from the SchoolHub Firebase project.</p><form id="shPushSetupForm"><label><input id="shPushGlobalEnabled" type="checkbox"> Enable server push delivery</label><label>Public Web Push key<input id="shPushKey" required autocomplete="off"></label><label>Messaging sender ID<input id="shPushSender" required inputmode="numeric"></label><label>Firebase Web app ID<input id="shPushApp" required></label><button type="submit">Save push setup</button></form></section></div></div></div>`;
  document.body.append(wrapper.firstElementChild);$('shMessagingClose').onclick=()=>{$('schoolHubMessagingDialog').classList.add('hidden');lastFocus?.focus();};$('shPushDeviceBtn').onclick=toggle;$('shPushRefresh').onclick=refresh;
  $('shOwnerSecurityTab').onclick=()=>window.SchoolHubOwnerSecurity.open().catch(showError);
  $('shMessagesTab').onclick=()=>pane('shSendSection');$('shSetupTab').onclick=()=>pane('shSetupSection');$('shDeviceTab').onclick=()=>pane('shDeviceSection');
  $('shMessageSchool').onchange=()=>loadRecipients().catch(showError);$('shMessageForm').onsubmit=send;$('shPushSetupForm').onsubmit=saveSetup;
  $('schoolHubMessagingDialog').addEventListener('keydown',e=>{if($('schoolHubMessagingDialog').dataset?.embedded==='true')return;if(e.key==='Escape')$('shMessagingClose').click();if(e.key==='Tab'){const all=[...$('schoolHubMessagingDialog').querySelectorAll('button,input,select,textarea')].filter(x=>!x.disabled&&x.getClientRects().length),first=all[0],last=all.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
  for(const name of ['Messages','Activity'])$('shPush'+name).onchange=async()=>{if(!choice().enabled)return;const t=generation,o=uid;try{await register(t,o);}catch(e){if(active(t,o))showError(e);}};
 }
 let lastFocus;
 function pane(id){for(const [section,tab] of [['shSendSection','shMessagesTab'],['shSetupSection','shSetupTab'],['shDeviceSection','shDeviceTab']]){$(section).hidden=section!==id;$(tab).setAttribute('aria-pressed',String(section===id));}}
 const showError=e=>text('shMessagingStatus',e.message||'Please try again.');
 async function refresh(){
  const t=generation,o=uid;if(!o)return;try{const result=await call('getSchoolHubPushDiagnostics');if(!active(t,o))return;const latest=result.latest;text('shPushDiagnostics',`${result.devices.filter(d=>d.enabled).length} enabled browser(s). ${latest?'Last delivery: '+latest.state.replaceAll('_',' ')+'. FCM acceptance does not confirm display.':'No server delivery attempt recorded yet.'}`);}catch(e){if(active(t,o))showError(e);}renderDevice();
 }
 async function loadRecipients(){
  const t=generation,o=uid,school=access.owner?$('shMessageSchool').value:access.schoolId,select=$('shMessageRecipient');select.replaceChildren(new Option('All active recipients',''));if(!school)return;
  const r=await call('getSchoolHubMessageDirectory',{schoolId:school});if(!active(t,o)||school!==(access.owner?$('shMessageSchool').value:access.schoolId))return;for(const m of r.members)select.add(new Option(m.name,m.uid));
 }
 async function open(initial={}){
  makeUI();lastFocus=document.activeElement;$('schoolHubMessagingDialog').classList.remove('hidden');if($('schoolHubMessagingDialog').dataset?.embedded!=='true')$('shMessagingClose').focus();text('shMessagingStatus',uid?'Loading…':'Sign in to SchoolHub first.');if(!uid)return;
  const t=generation,o=uid;try{
   const [a,s]=await Promise.all([call('getSchoolHubMessagingAccess'),call('getSchoolHubPushSettings')]);if(!active(t,o))return;access=a;settings=s;
   $('shOwnerSecurityTab').hidden=!(a.owner&&window.SchoolHubOwnerSecurity);$('shMessagesTab').hidden=!a.canSend;$('shSetupTab').hidden=!a.owner;pane(a.canSend?'shSendSection':'shDeviceSection');$('shSchoolWrap').hidden=!a.owner;text('shSenderScope',a.owner?'Project owner: send a service message across schools or choose one school.':'Head Teacher: messages go only to active teachers in your school.');
   $('shPushGlobalEnabled').checked=s.enabled;$('shPushKey').value=s.publicKey;$('shPushSender').value=s.messagingSenderId;$('shPushApp').value=s.appId;
   const old=choice();$('shPushMessages').checked=old.preferences?.messages!==false;$('shPushActivity').checked=old.preferences?.activity!==false;
   if(a.owner){const r=await call('getSchoolHubMessageDirectory');if(!active(t,o))return;const select=$('shMessageSchool');select.replaceChildren(new Option('Unarchived schools · active Head Teachers and teachers',''));for(const p of r.schools)select.add(new Option(p.name,p.id));if(initial?.schoolId){if(!Array.from(select.options).some(p=>p.value===initial.schoolId))select.add(new Option(initial.schoolName||initial.schoolId,initial.schoolId));select.value=initial.schoolId;}if(r.more)text('shMessagingStatus','Showing the first 100 schools.');}
   if(a.canSend)await loadRecipients();if(active(t,o)){text('shMessagingStatus','');await refresh();}
  }catch(e){if(active(t,o))showError(e);}renderDevice();
 }
 async function send(e){
  e.preventDefault();if(busy||!access?.canSend)return;const t=generation,o=uid,payload={schoolId:access.owner?$('shMessageSchool').value:access.schoolId,recipientUid:$('shMessageRecipient').value,title:$('shMessageTitle').value,body:$('shMessageBody').value};
  const label=payload.recipientUid?$('shMessageRecipient').selectedOptions[0].textContent:payload.schoolId?'all active '+(access.owner?'staff':'teachers')+' in this school':'active Head Teachers and teachers across all UNARCHIVED schools';
  if(!confirm(`Send “${payload.title}” to ${label}?\n\n${payload.body}`))return;
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload))),fingerprint=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');if(!active(t,o))return;
  try{request=JSON.parse(sessionStorage.getItem('schoolhub-message-request-'+o)||'null');}catch(_){request=null;}
  if(!request||request.fingerprint!==fingerprint)request={fingerprint,id:crypto.randomUUID()};
  try{sessionStorage.setItem('schoolhub-message-request-'+o,JSON.stringify(request));}catch(_){}busy=true;$('shMessageSend').disabled=true;
  try{const r=await call('sendSchoolHubMessage',{...payload,requestId:request.id});if(!active(t,o))return;text('shMessagingStatus','Message queued. Checking delivery to inboxes…');for(let i=0;i<20;i++){const status=await call('getSchoolHubMessageStatus',{jobId:r.jobId});if(!active(t,o))return;if(['complete','cancelled'].includes(status.state)){text('shMessagingStatus',status.state==='complete'?`Message saved to ${status.sent} inbox(es). Push is sent only to opted-in devices.`:'Delivery stopped because sender access changed.');if(status.state==='complete'){$('shMessageForm').reset();request=null;try{sessionStorage.removeItem('schoolhub-message-request-'+o);}catch(_){}await loadRecipients();}return;}await new Promise(resolve=>setTimeout(resolve,1500));}text('shMessagingStatus','Delivery is still processing. Retry with the same text to check it without sending a duplicate.');}
  catch(err){if(active(t,o))showError(err);}finally{if(active(t,o)){busy=false;$('shMessageSend').disabled=false;}}
 }
 async function saveSetup(e){e.preventDefault();if(busy||!access?.owner)return;const t=generation,o=uid;busy=true;const button=e.target.querySelector('button');button.disabled=true;try{const r=await call('setSchoolHubPushSettings',{enabled:$('shPushGlobalEnabled').checked,publicKey:$('shPushKey').value.trim(),messagingSenderId:$('shPushSender').value.trim(),appId:$('shPushApp').value.trim()});if(active(t,o)){settings=r;text('shMessagingStatus','Push setup saved. Each person must enable push on their device.');}}catch(err){if(active(t,o))showError(err);}finally{if(active(t,o)){busy=false;button.disabled=false;renderDevice();}}}
 async function changed(user){
  const t=++generation;uid=user?.uid||'';access=null;settings=null;busy=false;request=null;
  if($('schoolHubMessagingDialog')){$('schoolHubMessagingDialog').classList.add('hidden');$('shMessageForm').reset();$('shPushSetupForm').reset();$('shOwnerSecurityTab').hidden=true;$('shMessagesTab').hidden=true;$('shSetupTab').hidden=true;pane('shDeviceSection');$('shMessageSend').disabled=false;$('shPushSetupForm').querySelector('button').disabled=false;}
  if(uid&&user.emailVerified&&$('shStandaloneOpen')){text('shStandaloneAccount','Signed in as '+user.email);open().catch(showError);}
  await bind('').catch(()=>{});if(!uid||!user.emailVerified){text('shStandaloneAccount',uid?'Verify your login email to continue.':'Sign in to SchoolHub to continue.');renderDevice();return;}const owner=uid;
  try{const s=await call('getSchoolHubPushSettings');if(!active(t,owner))return;settings=s;if(s.enabled&&supported()&&Notification.permission==='granted'&&choice(owner).enabled)await register(t,owner);}catch(e){if(active(t,owner))text('notificationBrowserStatus',e.message);}if(active(t,owner))renderDevice();
 }
 window.SchoolHubPush={open,toggle,render:renderDevice,enabled:()=>choice().enabled===true};
 function start(){if(!globalThis.firebase?.apps?.length){setTimeout(start,100);return;}makeUI();firebase.auth().onAuthStateChanged(changed);$('profileMessagingBtn')?.addEventListener('click',open);$('shStandaloneOpen')?.addEventListener('click',open);}
 start();window.addEventListener('online',async()=>{const t=generation,o=uid;if(!o)return;try{const s=await call('getSchoolHubPushSettings');if(!active(t,o))return;settings=s;if(s.enabled&&supported()&&Notification.permission==='granted'&&choice(o).enabled)await register(t,o);}catch(error){if(active(t,o))text('notificationBrowserStatus',error.message);}if(active(t,o))renderDevice();});
})();
