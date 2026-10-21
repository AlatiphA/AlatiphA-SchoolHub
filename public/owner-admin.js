(function(){
 'use strict';
 const $=id=>document.getElementById(id),tabs=['overview','schools','messages','licences','activity','security'];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const integer=v=>Number.isSafeInteger(v)&&v>=0?v:0;
 const date=v=>v&&Number.isFinite(Number(v))?new Date(Number(v)).toLocaleString():'Not recorded';
 const text=(id,value)=>{$(id).textContent=value;};
 const call=(name,data={})=>firebase.app().functions('africa-south1').httpsCallable(name)(data).then(r=>r.data);
 let epoch=0,uid='',allowed=false,messagesLoaded=false,modeChosen=false,schoolAction=null,actionBusy=false,lastDeletion='';
 const page=()=>({cursor:'',next:'',history:[],rows:[],loaded:false,busy:false,seq:0});let pages={schools:page(),licences:page(),activity:page()};
 const active=(e,u)=>epoch===e&&uid===u&&firebase.auth().currentUser?.uid===u&&allowed;
 function clear(){
  allowed=false;messagesLoaded=false;modeChosen=false;schoolAction=null;actionBusy=false;lastDeletion='';$('ownerSchoolDialog')?.close();$('ownerSchoolConfirmId').value='';$('ownerSchoolConfirmPhrase').value='';$('ownerSchoolBackupConfirmed').checked=false;$('ownerSchoolArchiveFilter').value='active';$('ownerCheckDeletion').hidden=true;$('ownerRetryDeletion').hidden=true;pages={schools:page(),licences:page(),activity:page()};$('ownerDashboard').hidden=true;
  for(const id of ['ownerOverviewCards','ownerOverviewDetails','ownerSchoolsList','ownerLicencesList','ownerActivityList'])$(id).replaceChildren();
  for(const id of ['ownerOverviewStatus','ownerSchoolsStatus','ownerLicencesStatus','ownerActivityStatus','ownerSecurityAccount'])text(id,'');
  for(const id of ['ownerSchoolActionIdentity','ownerSchoolActionExplanation','ownerSchoolActionStatus'])text(id,'');$('ownerSchoolDeletionSummary').replaceChildren();for(const id of ['ownerSchoolActionSubmit','ownerSchoolActionCancel','ownerSchoolDialogClose'])$(id).disabled=false;
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
  const s=pages.schools,q=$('ownerSchoolSearch').value.trim().toLowerCase(),filter=$('ownerSchoolFilter').value,status=$('ownerSchoolArchiveFilter').value,rows=s.rows.filter(r=>matching(r,q)&&(filter==='all'||r.registration===filter)&&(status==='all'||(status==='archived')===(r.archived===true)));
  $('ownerSchoolsList').innerHTML=rows.length?table(['School','Head Teacher','Registration','Added',''],rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong><span class="owner-badge">${r.administrationState==='deleting'?'Deletion in progress':r.archived?'Archived':'Active'}</span><small>School ID: ${esc(r.id)}</small>${r.contactEmail?'<small>School contact: '+esc(r.contactEmail)+'</small>':''}</td><td>${esc(r.headName||'Not linked')}<small>${esc(r.headEmail)}</small></td><td><span class="owner-badge">${r.registration==='linked'?'Head Teacher linked':'Needs review'}</span><small>Owner ID: ${esc(r.ownerUid||'Not recorded')}</small></td><td>${esc(date(r.createdAtMs))}</td><td><div class="owner-actions">${r.administrationState==='deleting'?`<button class="owner-button" type="button" data-owner-check-id="${esc(r.id)}">Check deletion</button>`:`${!r.archived?`<button class="owner-button" type="button" data-owner-message-id="${esc(r.id)}">Message school</button>`:''}<button class="owner-button" type="button" data-owner-manage-id="${esc(r.id)}" data-owner-action="${r.archived?'restore':'archive'}">${r.archived?'Restore':'Archive'}</button>${r.archived?`<button class="owner-button owner-button-danger" type="button" data-owner-manage-id="${esc(r.id)}" data-owner-action="delete">Delete permanently</button>`:''}`}</div></td></tr>`).join('')):'<div class="owner-empty">'+(s.rows.length?'No matches on this page. Check other pages if needed.':'No school records found.')+'</div>';
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
  $('ownerActivityList').innerHTML=s.rows.length?table(kind==='messages'?['When','Message','Audience','Status','Saved inboxes']:kind==='schools'?['When','Action','School','Actor']:['When','Action','Push delivery','Actor'],s.rows.map(r=>kind==='messages'?`<tr><td>${esc(date(r.atMs))}</td><td><strong>${esc(r.title||'Message')}</strong><small>Actor: ${esc(r.actorUid)}</small></td><td>${esc({'all-schools':'All schools','one-school':'One school','one-recipient':'One recipient'}[r.scope]||'Unknown')}<small>${esc(r.schoolId)}</small></td><td>${esc(r.state)}</td><td>${integer(r.sent)}</td></tr>`:kind==='schools'?`<tr><td>${esc(date(r.atMs))}</td><td>${esc({'school.archived':'School archived','school.restored':'School restored','school.deletion-started':'Permanent deletion started','school.deleted':'School permanently deleted'}[r.action]||r.action)}</td><td>${esc(r.schoolName)}<small>${esc(r.schoolId)}</small></td><td>${esc(r.actorUid)}</td></tr>`:`<tr><td>${esc(date(r.atMs))}</td><td>${r.action==='push.configured'?'Push setup saved':esc(r.action)}</td><td>${r.enabled?'Enabled':'Disabled'}</td><td>${esc(r.actorUid)}</td></tr>`).join('')):'<div class="owner-empty">No recorded '+(kind==='messages'?'messages':kind==='schools'?'school management events':'push setup changes')+' found.</div>';
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

 function closeSchoolReview(){if(actionBusy)return;$('ownerSchoolDialog').close();schoolAction=null;$('ownerSchoolConfirmId').value='';$('ownerSchoolConfirmPhrase').value='';$('ownerSchoolBackupConfirmed').checked=false;}
 async function openSchoolReview(row,action){
  if(!allowed||actionBusy||row.administrationState==='deleting')return;const e=epoch,u=uid;
  schoolAction={row:{...row},action,requestId:crypto.randomUUID(),review:null};const current=schoolAction,dialog=$('ownerSchoolDialog');
  $('ownerSchoolConfirmId').value='';$('ownerSchoolConfirmPhrase').value='';$('ownerSchoolBackupConfirmed').checked=false;
  text('ownerSchoolDialogTitle',action==='delete'?'Delete school permanently?':action==='restore'?'Restore school?':'Archive school?');
  text('ownerSchoolActionIdentity',row.name+' · School ID: '+row.id+' · Head Teacher: '+(row.headEmail||row.headName||'Not linked'));
  text('ownerSchoolActionExplanation',action==='delete'?'Permanently remove this school’s pupils, grades, attendance, fees, licences, photos, signatures and other cloud records. Staff will be unlinked; their sign-in accounts will remain. This cannot be undone from SchoolHub.':action==='restore'?'Return this school to the active owner list and service-message recipients. Existing school records and access are retained.':'Move this school to Archived schools and exclude it from new service messages. School records, licences and existing access are retained.');
  $('ownerSchoolDeletionSummary').replaceChildren();$('ownerSchoolDeleteConfirmation').hidden=action!=='delete';$('ownerSchoolConfirmPhrase').required=action==='delete';
  text('ownerSchoolActionStatus',action==='delete'?'Reviewing cloud records…':'');text('ownerSchoolActionSubmit',action==='delete'?'Delete permanently':action==='restore'?'Restore school':'Archive school');
  $('ownerSchoolActionSubmit').classList.toggle('owner-button-danger',action==='delete');$('ownerSchoolActionSubmit').disabled=action==='delete';dialog.showModal();
  if(action!=='delete')return;
  try{const review=await call('reviewSchoolHubOwnerSchoolDeletion',{schoolId:row.id,revision:row.revision||0});if(!active(e,u)||schoolAction!==current)return;current.review=review;
   $('ownerSchoolDeletionSummary').innerHTML='<h3>Deletion review</h3><p>'+integer(review.members)+' staff membership(s) to unlink · '+integer(review.joinCodes)+' join code(s) · '+integer(review.imageVersions)+(review.moreImages?'+':'')+' stored image version(s).</p><ul>'+review.collections.map(r=>'<li>'+esc(r.collection)+': '+integer(r.count)+' record(s)</li>').join('')+'</ul><p class="owner-note">Counts cover current top-level collections; nested records and this school’s saved messages are also removed. Counts may change before deletion starts.</p>';
   text('ownerSchoolActionStatus','Review expires in ten minutes. Permanent deletion requires a sign-in within the last ten minutes.');$('ownerSchoolActionSubmit').disabled=false;
  }catch(error){if(active(e,u)&&schoolAction===current)text('ownerSchoolActionStatus',String(error?.message||'Could not review deletion. Close and retry.'));}
 }
 async function submitSchoolAction(event){
  event.preventDefault();if(!allowed||actionBusy||!schoolAction)return;const e=epoch,u=uid,current=schoolAction,{row,action}=current;
  if($('ownerSchoolConfirmId').value!==row.id){text('ownerSchoolActionStatus','Type the exact school ID shown above.');return;}
  if(action==='delete'&&(!current.review||$('ownerSchoolConfirmPhrase').value!=='DELETE SCHOOL'||!$('ownerSchoolBackupConfirmed').checked)){text('ownerSchoolActionStatus','Type DELETE SCHOOL and confirm your backup or acceptance of permanent data loss.');return;}
  actionBusy=true;for(const id of ['ownerSchoolActionSubmit','ownerSchoolActionCancel','ownerSchoolDialogClose'])$(id).disabled=true;
  try{const result=await call(action==='delete'?'deleteSchoolHubOwnerSchool':'setSchoolHubOwnerSchoolArchive',{schoolId:row.id,revision:row.revision||0,confirmSchoolId:$('ownerSchoolConfirmId').value,...(action==='delete'?{token:current.review.token,confirmPhrase:$('ownerSchoolConfirmPhrase').value,backupConfirmed:$('ownerSchoolBackupConfirmed').checked}:{archived:action==='archive',requestId:current.requestId})});
   if(!active(e,u)||schoolAction!==current)return;
   if(action==='delete'){lastDeletion=row.id;$('ownerCheckDeletion').hidden=false;}
   actionBusy=false;closeSchoolReview();pages.licences.loaded=false;pages.activity.loaded=false;
   await loadSchools('schools');if(active(e,u))text('ownerSchoolsStatus',action==='delete'?'Permanent deletion started for '+row.name+'. Use Check last deletion for progress.':(action==='archive'?'Archived ':'Restored ')+row.name+'. Choose the matching school-status filter to view it.');
  }catch(error){if(active(e,u)&&schoolAction===current){if(/permission-denied|unauthenticated/.test(String(error?.code)))errorAt('ownerSchoolActionStatus',error);else text('ownerSchoolActionStatus',String(error?.message||'Could not complete the action. Retry with the same review.'));}}
  finally{if(epoch===e){actionBusy=false;for(const id of ['ownerSchoolActionSubmit','ownerSchoolActionCancel','ownerSchoolDialogClose'])$(id).disabled=false;}}
 }
 async function checkDeletion(schoolId=lastDeletion){
  if(!allowed||!schoolId)return;lastDeletion=schoolId;$('ownerCheckDeletion').hidden=false;const e=epoch,u=uid;
  try{const status=await call('getSchoolHubOwnerSchoolDeletionStatus',{schoolId});if(!active(e,u))return;await loadSchools('schools');if(!active(e,u))return;
   const phases={members:'unlinking staff',joinCodes:'removing join codes',messageJobs:'removing school message jobs','user-data':'removing this school’s saved notices and registration receipts',images:'removing school images',records:'removing school records',verify:'verifying cleanup',complete:'complete'};
   $('ownerRetryDeletion').hidden=!status?.canResume;text('ownerRetryDeletion','Retry cleanup · '+schoolId);
   text('ownerSchoolsStatus',status?.state==='complete'?'School permanently deleted. Staff sign-in accounts were retained.':status?'Deletion in progress: '+(phases[status.phase]||'cleanup')+'. Check again shortly.':'No deletion job found for this school.');
  }catch(error){if(active(e,u))errorAt('ownerSchoolsStatus',error);}
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
  $('ownerSchoolSearch').oninput=renderSchools;$('ownerSchoolArchiveFilter').onchange=renderSchools;$('ownerSchoolFilter').onchange=renderSchools;$('ownerLicenceSearch').oninput=renderLicences;$('ownerLicenceMode').onchange=()=>{modeChosen=true;renderLicences();};
  $('ownerActivityKind').onchange=()=>{pages.activity.seq++;pages.activity=page();$('ownerActivityList').replaceChildren();loadActivity();};
  for(const [kind,label] of [['schools','Schools'],['licences','Licences'],['activity','Activity']])for(const direction of ['Previous','Next'])$('owner'+label+direction).onclick=()=>kind==='activity'?loadActivity(direction.toLowerCase()):loadSchools(kind,direction.toLowerCase());
  $('ownerSchoolsList').onclick=e=>{const b=e.target.closest('[data-owner-message-id],[data-owner-manage-id],[data-owner-check-id]');if(!b)return;if(b.dataset.ownerCheckId){checkDeletion(b.dataset.ownerCheckId);return;}const row=pages.schools.rows.find(r=>r.id===(b.dataset.ownerMessageId||b.dataset.ownerManageId));if(!row)return;if(b.dataset.ownerManageId)openSchoolReview(row,b.dataset.ownerAction);else if(!row.archived&&row.administrationState!=='deleting')showTab('messages',{schoolId:row.id,schoolName:row.name});};
  $('ownerSchoolDialogClose').onclick=closeSchoolReview;$('ownerSchoolActionCancel').onclick=closeSchoolReview;$('ownerSchoolActionForm').onsubmit=submitSchoolAction;$('ownerSchoolDialog').addEventListener('cancel',e=>{e.preventDefault();closeSchoolReview();});$('ownerCheckDeletion').onclick=()=>checkDeletion();$('ownerRetryDeletion').onclick=async()=>{if(!allowed||!lastDeletion)return;const e=epoch,u=uid,id=lastDeletion;$('ownerRetryDeletion').disabled=true;try{await call('resumeSchoolHubOwnerSchoolDeletion',{schoolId:id,confirmSchoolId:id});if(active(e,u))await checkDeletion(id);}catch(error){if(active(e,u))text('ownerSchoolsStatus',String(error?.message||'Could not resume cleanup.'));}finally{if(active(e,u))$('ownerRetryDeletion').disabled=false;}};
  $('shStandaloneSignOut').onclick=async()=>{const button=$('shStandaloneSignOut');button.disabled=true;try{await firebase.auth().signOut();location.replace('./');}catch(error){text('ownerAccessStatus','Sign out failed. Check your connection and retry.');button.disabled=false;}};
  firebase.auth().onAuthStateChanged(authChanged);
 }
 window.SchoolHubOwnerAdmin={showTab};start();
})();
