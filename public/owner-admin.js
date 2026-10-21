(function(){
 'use strict';
 const $=id=>document.getElementById(id),tabs=['overview','schools','messages','licences','activity','security'];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const integer=v=>Number.isSafeInteger(v)&&v>=0?v:0;
 const date=v=>v&&Number.isFinite(Number(v))?new Date(Number(v)).toLocaleString():'Not recorded';
 const text=(id,value)=>{$(id).textContent=value;};
 const call=(name,data={})=>firebase.app().functions('africa-south1').httpsCallable(name)(data).then(r=>r.data);
 let epoch=0,uid='',allowed=false,messagesLoaded=false,modeChosen=false;
 const page=()=>({cursor:'',next:'',history:[],rows:[],loaded:false,busy:false,seq:0});let pages={schools:page(),licences:page(),activity:page()};
 const active=(e,u)=>epoch===e&&uid===u&&firebase.auth().currentUser?.uid===u&&allowed;
 function clear(){
  allowed=false;messagesLoaded=false;modeChosen=false;pages={schools:page(),licences:page(),activity:page()};$('ownerDashboard').hidden=true;
  for(const id of ['ownerOverviewCards','ownerOverviewDetails','ownerSchoolsList','ownerLicencesList','ownerActivityList'])$(id).replaceChildren();
  for(const id of ['ownerOverviewStatus','ownerSchoolsStatus','ownerLicencesStatus','ownerActivityStatus','ownerSecurityAccount'])text(id,'');
  for(const id of ['ownerSchoolSearch','ownerLicenceSearch'])$(id).value='';
  for(const id of ['shMessageForm','shPushSetupForm'])$(id)?.reset();
  $('ownerSchoolFilter').value='all';$('ownerActivityKind').value='messages';
  const security=$('ownerAccountSecurityDialog');if(security){security.querySelectorAll('input').forEach(n=>n.value='');security.remove();}
 }
 function errorAt(id,error){
  if(/permission-denied|unauthenticated/.test(String(error?.code))){clear();text('ownerAccessStatus','Owner access could not be confirmed. Sign in with your owner account.');$('ownerSignInLink').hidden=false;return;}
  text(id,'Could not load this information. Check your connection and retry.');
 }
 function overviewCards(data){
  const cards=[['School records',data.schoolRecords,'Includes test and incomplete records'],['Head Teachers',data.activeHeads,'Active school memberships'],['Teachers',data.activeTeachers,'Active school memberships'],['Pending approvals',data.pendingTeachers,'Teacher requests awaiting approval']];
  return cards.map(([label,value,note])=>`<div class="owner-card"><p>${esc(label)}</p><strong>${integer(value)}</strong><small>${esc(note)}</small></div>`).join('');
 }
 async function loadOverview(){
  const e=epoch,u=uid;if(!allowed)return;$('ownerRefreshOverview').disabled=true;text('ownerOverviewStatus','Loading overview…');
  try{const data=await call('getSchoolHubOwnerOverview');if(!active(e,u))return;
   $('ownerOverviewCards').innerHTML=overviewCards(data);
   $('ownerOverviewDetails').innerHTML=`<div class="owner-status-card"><h3>Messages &amp; Push</h3><span class="owner-badge">${data.pushEnabled?'Server push enabled':'Push setup not enabled'}</span><p>Send service messages to a school or selected active recipients.</p><button class="owner-button" type="button" data-owner-go="messages">Open Messages &amp; Push</button></div><div class="owner-status-card"><h3>School licences</h3><span class="owner-badge ${data.checkoutTestOnly?'owner-badge-test':''}">${data.checkoutTestOnly?'Test checkout · live billing disabled':'Live checkout enabled'}</span><p>Review three-year licences, existing lifetime licences and report credits.</p><button class="owner-button" type="button" data-owner-go="licences">View licences</button></div>`;
   if(!modeChosen)$('ownerLicenceMode').value=data.checkoutTestOnly?'test':'live';
   text('ownerOverviewStatus','Last checked: '+date(data.asOfMs));
  }catch(error){if(active(e,u))errorAt('ownerOverviewStatus',error);}finally{if(active(e,u))$('ownerRefreshOverview').disabled=false;}
 }
 function pager(kind,label){const s=pages[kind],prefix='owner'+label;$(`${prefix}Previous`).disabled=s.busy||!s.history.length;$(`${prefix}Next`).disabled=s.busy||!s.next;text(prefix+'Page','Page '+(s.history.length+1));}
 function table(headers,body){return `<div class="owner-table-wrap"><table class="owner-table"><thead><tr>${headers.map(h=>'<th scope="col">'+esc(h)+'</th>').join('')}</tr></thead><tbody>${body}</tbody></table></div>`;}
 function matching(row,query){return [row.name,row.id,row.headEmail,row.contactEmail].some(v=>String(v||'').toLowerCase().includes(query));}
 function renderSchools(){
  const s=pages.schools,q=$('ownerSchoolSearch').value.trim().toLowerCase(),filter=$('ownerSchoolFilter').value,rows=s.rows.filter(r=>matching(r,q)&&(filter==='all'||r.registration===filter));
  $('ownerSchoolsList').innerHTML=rows.length?table(['School','Head Teacher','Registration','Added',''],rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong><small>School ID: ${esc(r.id)}</small>${r.contactEmail?'<small>School contact: '+esc(r.contactEmail)+'</small>':''}</td><td>${esc(r.headName||'Not linked')}<small>${esc(r.headEmail)}</small></td><td><span class="owner-badge">${r.registration==='linked'?'Head Teacher linked':'Needs review'}</span><small>Owner ID: ${esc(r.ownerUid||'Not recorded')}</small></td><td>${esc(date(r.createdAtMs))}</td><td><button class="owner-button" type="button" data-owner-message-id="${esc(r.id)}">Message school</button></td></tr>`).join('')):'<div class="owner-empty">'+(s.rows.length?'No matches on this page. Check other pages if needed.':'No school records found.')+'</div>';
  pager('schools','Schools');
 }
 function renderLicences(){
  const s=pages.licences,mode=$('ownerLicenceMode').value,q=$('ownerLicenceSearch').value.trim().toLowerCase(),rows=s.rows.filter(r=>matching(r,q));
  text('ownerLicenceModeNote',mode==='test'?'Test licences and test credits are separate from live entitlements. No real payment is represented here.':'Live licences and report credits only. Test purchases are excluded.');
  const names={'three-year':'3-year School Licence',lifetime:'Lifetime School Licence','pay-as-you-go':'Pay as you go'},states={active:'Active',expired:'Expired',inactive:'Inactive','needs-review':'Needs review',none:'No active school licence'};
  $('ownerLicencesList').innerHTML=rows.length?table(['School','Environment','Licence','Status / expiry','Report credits'],rows.map(r=>{const p=r.licences[mode];return `<tr><td><strong>${esc(r.name)}</strong><small>${esc(r.id)}</small></td><td><span class="owner-badge ${mode==='test'?'owner-badge-test':''}">${mode==='test'?'TEST':'LIVE'}</span></td><td>${esc(names[p.plan]||'Unknown')}${p.plan==='lifetime'?'<small>Existing entitlement retained</small>':''}</td><td>${esc(states[p.state]||'Needs review')}<small>${p.expiresAt?'Expires: '+esc(date(Date.parse(p.expiresAt))):p.plan==='lifetime'?'No expiry recorded':''}</small></td><td>${integer(r.credits[mode])} ${mode==='test'?'test credits':'credits'}</td></tr>`;}).join('')):'<div class="owner-empty">'+(s.rows.length?'No matches on this page.':'No school records found.')+'</div>';
  pager('licences','Licences');
 }
 async function loadSchools(kind,direction='refresh'){
  if(!allowed)return;const e=epoch,u=uid,s=pages[kind];if(s.busy)return;const label=kind==='schools'?'Schools':'Licences',prefix='owner'+label;
  const cursor=direction==='next'?s.next:direction==='previous'?s.history.at(-1)||'':'';
  if(direction==='next'&&!cursor||direction==='previous'&&!s.history.length)return;
  const history=direction==='next'?[...s.history,s.cursor]:direction==='previous'?s.history.slice(0,-1):[];
  s.busy=true;const seq=++s.seq;$(prefix==='ownerSchools'?'ownerRefreshSchools':'ownerRefreshLicences').disabled=true;pager(kind,label);text(prefix+'Status','Loading school records…');
  try{const result=await call('listSchoolHubOwnerSchools',{cursor});if(!active(e,u)||seq!==s.seq)return;Object.assign(s,{cursor,next:result.nextCursor,history,rows:result.schools,loaded:true});if(kind==='schools')renderSchools();else renderLicences();text(prefix+'Status',result.schools.length+' school record(s) on this page. Checked: '+date(result.asOfMs));}
  catch(error){if(active(e,u)&&seq===s.seq)errorAt(prefix+'Status',error);}finally{if(active(e,u)&&seq===s.seq){s.busy=false;$(kind==='schools'?'ownerRefreshSchools':'ownerRefreshLicences').disabled=false;pager(kind,label);}}
 }
 function renderActivity(){
  const s=pages.activity,kind=$('ownerActivityKind').value;
  $('ownerActivityList').innerHTML=s.rows.length?table(kind==='messages'?['When','Message','Audience','Status','Saved inboxes']:['When','Action','Push delivery','Actor'],s.rows.map(r=>kind==='messages'?`<tr><td>${esc(date(r.atMs))}</td><td><strong>${esc(r.title||'Message')}</strong><small>Actor: ${esc(r.actorUid)}</small></td><td>${esc({'all-schools':'All schools','one-school':'One school','one-recipient':'One recipient'}[r.scope]||'Unknown')}<small>${esc(r.schoolId)}</small></td><td>${esc(r.state)}</td><td>${integer(r.sent)}</td></tr>`:`<tr><td>${esc(date(r.atMs))}</td><td>${r.action==='push.configured'?'Push setup saved':esc(r.action)}</td><td>${r.enabled?'Enabled':'Disabled'}</td><td>${esc(r.actorUid)}</td></tr>`).join('')):'<div class="owner-empty">No recorded '+(kind==='messages'?'messages':'push setup changes')+' found.</div>';
  pager('activity','Activity');
 }
 async function loadActivity(direction='refresh'){
  const s=pages.activity;if(!allowed||s.busy)return;const e=epoch,u=uid,kind=$('ownerActivityKind').value,cursor=direction==='next'?s.next:direction==='previous'?s.history.at(-1)||'':'';
  if(direction==='next'&&!cursor||direction==='previous'&&!s.history.length)return;
  const history=direction==='next'?[...s.history,s.cursor]:direction==='previous'?s.history.slice(0,-1):[];
  s.busy=true;const seq=++s.seq;$('ownerRefreshActivity').disabled=true;pager('activity','Activity');text('ownerActivityStatus','Loading activity…');
  try{const result=await call('listSchoolHubOwnerActivity',{kind,cursor});if(!active(e,u)||seq!==s.seq||kind!==$('ownerActivityKind').value)return;Object.assign(s,{cursor,next:result.nextCursor,history,rows:result.items,loaded:true});renderActivity();text('ownerActivityStatus',result.items.length+' recorded event(s) on this page.');}
  catch(error){if(active(e,u)&&seq===s.seq)errorAt('ownerActivityStatus',error);}finally{if(active(e,u)&&seq===s.seq){s.busy=false;$('ownerRefreshActivity').disabled=false;pager('activity','Activity');}}
 }
 async function showTab(name,selection){
  if(!allowed||!tabs.includes(name))return;
  document.querySelectorAll('[data-owner-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.ownerTab===name)));
  for(const key of tabs)$('ownerPanel-'+key).hidden=key!==name;
  history.replaceState(history.state,'','#'+name);
  if(name==='overview')return loadOverview();
  if(name==='schools'&&!pages.schools.loaded)return loadSchools('schools');
  if(name==='licences'){if(!pages.licences.loaded)return loadSchools('licences');renderLicences();}
  if(name==='activity'&&!pages.activity.loaded)return loadActivity();
  if(name==='messages'&&(!messagesLoaded||selection)){
   const e=epoch,u=uid;await window.SchoolHubPush.open(selection||{});if(active(e,u))messagesLoaded=true;
  }
 }
 async function authChanged(user){
  const e=++epoch;uid=user?.uid||'';clear();$('ownerSignInLink').hidden=true;
  text('shStandaloneAccount',user?'Signed in as '+(user.email||''):'Not signed in');
  if(!user){text('ownerAccessStatus','Sign in to SchoolHub with your owner account to continue.');$('ownerSignInLink').hidden=false;return;}
  text('ownerAccessStatus','Confirming owner access…');
  try{const access=await call('getSchoolHubMessagingAccess');if(e!==epoch||firebase.auth().currentUser?.uid!==user.uid)return;
   if(access.owner!==true){text('ownerAccessStatus','This account does not have Owner Administration access. Open SchoolHub for your school portal.');$('ownerSignInLink').hidden=false;return;}
   allowed=true;$('ownerDashboard').hidden=false;text('ownerAccessStatus','');text('ownerSecurityAccount',user.email+' · '+(user.emailVerified?'Email verified':'Email verification required'));
   const requested=location.hash.slice(1);await showTab(tabs.includes(requested)?requested:'overview');
  }catch(error){if(e===epoch){text('ownerAccessStatus','Could not confirm owner access. Check your connection and sign in again if needed.');$('ownerSignInLink').hidden=false;}}
 }
 function start(){
  try{const theme=localStorage.getItem('arc_theme');if(['light','dark'].includes(theme))document.documentElement.dataset.theme=theme;}catch(_){}
  const messages=$('schoolHubMessagingDialog');if(messages){messages.dataset.embedded='true';messages.removeAttribute('role');messages.removeAttribute('aria-modal');$('ownerMessagesMount').append(messages);}
  document.querySelectorAll('[data-owner-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.ownerTab));
  $('ownerOverviewDetails').onclick=e=>{const b=e.target.closest('[data-owner-go]');if(b)showTab(b.dataset.ownerGo);};
  $('ownerRefreshOverview').onclick=loadOverview;$('ownerRefreshSchools').onclick=()=>loadSchools('schools');$('ownerRefreshLicences').onclick=()=>loadSchools('licences');$('ownerRefreshActivity').onclick=()=>loadActivity();
  $('ownerSchoolSearch').oninput=renderSchools;$('ownerSchoolFilter').onchange=renderSchools;$('ownerLicenceSearch').oninput=renderLicences;$('ownerLicenceMode').onchange=()=>{modeChosen=true;renderLicences();};
  $('ownerActivityKind').onchange=()=>{pages.activity.seq++;pages.activity=page();$('ownerActivityList').replaceChildren();loadActivity();};
  for(const [kind,label] of [['schools','Schools'],['licences','Licences'],['activity','Activity']])for(const direction of ['Previous','Next'])$('owner'+label+direction).onclick=()=>kind==='activity'?loadActivity(direction.toLowerCase()):loadSchools(kind,direction.toLowerCase());
  $('ownerSchoolsList').onclick=e=>{const b=e.target.closest('[data-owner-message-id]');if(!b)return;const row=pages.schools.rows.find(r=>r.id===b.dataset.ownerMessageId);if(row)showTab('messages',{schoolId:row.id,schoolName:row.name});};
  $('shStandaloneSignOut').onclick=async()=>{const button=$('shStandaloneSignOut');button.disabled=true;try{await firebase.auth().signOut();location.replace('./');}catch(error){text('ownerAccessStatus','Sign out failed. Check your connection and retry.');button.disabled=false;}};
  firebase.auth().onAuthStateChanged(authChanged);
 }
 window.SchoolHubOwnerAdmin={showTab};start();
})();
