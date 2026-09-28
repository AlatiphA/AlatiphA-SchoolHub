/* Pending fee operations retain their identity across reconnects and reloads. */
const feeQueueLocks=new Map();
function feeWithLock(key,work){
 if(navigator.locks)return navigator.locks.request(key,work);
 const next=(feeQueueLocks.get(key)||Promise.resolve()).catch(()=>{}).then(work);feeQueueLocks.set(key,next);return next;
}
function feeQueueRead(key){return JSON.parse(localStorage.getItem(key)||'[]');}
function feeRejected(e){return /invalid-argument|failed-precondition|aborted|permission-denied|unauthenticated|not-found|already-exists/.test(e.code||'');}
async function feeFlush(key,active){
 return feeWithLock(key,async()=>{
  const results={};
  while(active()&&navigator.onLine!==false){
   const queue=feeQueueRead(key),item=queue[0];if(!item||item.error)break;
   try{results[item.request.requestId]=await safetyCall('updateSchoolFees',item.request);localStorage.setItem(key,JSON.stringify(queue.slice(1)));}
   catch(e){if(feeRejected(e)){item.error=e.message||String(e);localStorage.setItem(key,JSON.stringify(queue));}break;}
  }
  return results;
 });
}
window.addEventListener('online',()=>{if(isHeadTeacher()&&sessionReady)renderSchoolFees();});
let feeViewGeneration=0;
async function renderSchoolFees(){
 const host=document.getElementById('feesWrap'),generation=++feeViewGeneration,school=currentSchoolId,user=currentUid,session=sessionGeneration;
 const active=()=>generation===feeViewGeneration&&isCurrentSession(session,user,school)&&isHeadTeacher();
 if(!isHeadTeacher()||!FIREBASE_ENABLED){host.textContent='Sign in as Head Teacher to manage fees.';return;}
 const pendingKey='schoolhub_fee_queue_'+school+'_'+user,cacheKey='schoolhub_fee_cache_'+school+'_'+user;
 const legacyKey='schoolhub_fee_pending_'+school+'_'+user,legacy=localStorage.getItem(legacyKey);if(legacy){await feeWithLock(pendingKey,()=>{const q=feeQueueRead(pendingKey),request=JSON.parse(legacy);if(!q.some(x=>x.request.requestId===request.requestId))q.push({request});localStorage.setItem(pendingKey,JSON.stringify(q));localStorage.removeItem(legacyKey);});}
 host.textContent='Loading fees and receipts…';
 try{
  await feeFlush(pendingKey,active);if(!active())return;
  let data,cached=false;try{data=await safetyCall('getSchoolFees',{});if(!active())return;localStorage.setItem(cacheKey,JSON.stringify(data));}catch(e){const saved=localStorage.getItem(cacheKey);if(!saved)throw Error('Connect once to load your fee records before working offline.');data=JSON.parse(saved);cached=true;}if(!active())return;
  const settings=DB.get(KEYS.settings,{}),classes=DB.get(KEYS.classes,[]),esc=escapeHtml;
  const cash=n=>'GH₵ '+(Number(n||0)/100).toFixed(2);
  const cents=value=>{if(!/^-?\d+(\.\d{1,2})?$/.test(value.trim()))throw Error('Enter an amount with at most two decimal places.');return Math.round(Number(value)*100);};
  host.innerHTML=`<p>Record money received by the school. This page does not collect or transfer money. You can save offline on this device. Pending entries sync when connected; official receipt numbers are issued after confirmation.</p>
  <details><summary>Set a standard class fee</summary><p>Creates a charge for each active pupil for the selected term. Existing pupil charges stay unchanged; use the update controls below to correct them. Apply again to include newly enrolled pupils.</p>
  <label>Class<select id="feeClass">${classes.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
  <label>Term<select id="feeTerm">${['Term 1','Term 2','Term 3'].map(t=>`<option ${t===settings.currentTerm?'selected':''}>${t}</option>`).join('')}</select></label>
  <label>Academic year<input id="feeYear" value="${esc(settings.currentYear||'')}" placeholder="2026/2027"></label>
  <label>Fee per pupil (GH₵)<input id="feeAmount" type="number" min="0" step="0.01"></label><button id="feeApply" type="button" class="btn-primary">Apply class fee</button><label>Reason for editing or removing existing fees<input id="feeClassReason" maxlength="200"></label><button id="feeClassEdit" type="button">Update existing class fees</button><button id="feeClassCancel" type="button">Remove existing class fees</button><p>Updating changes the standard fee and preserves individual adjustments. Removal cancels unpaid charges and keeps their history.</p></details>
  <p id="feeMessage" role="status"></p><button id="feeRefresh" type="button" class="btn-secondary">Refresh balances</button>
  <h3>Pupil balances</h3><p>Each pupil’s latest term shows the previous unpaid balance plus new charges. Payments clear the oldest balance first, including balances from earlier academic years.</p>
  <label>Search pupil, class or term<input id="feeSearch" type="search" placeholder="Name, class, term or year"></label>
  <div id="feeTotals"></div><div class="table-scroll fee-table-scroll" role="region" aria-label="Pupil fee balances, scroll horizontally for more columns" tabindex="0"><table class="fee-balances-table"><thead><tr><th>Pupil / class</th><th>Term</th><th>Previous balance</th><th>Term charges</th><th>Total due</th><th>Actions</th></tr></thead><tbody id="feeRows"></tbody></table></div>
  <div id="feePupil"></div><button id="feeExport" type="button" class="btn-secondary">Export fees backup (JSON)</button>`;
  const msg=host.querySelector('#feeMessage');
  const queue=feeQueueRead(pendingKey);
  msg.textContent=(cached?'Showing saved balances. ':'')+(queue.length?`${queue.length} pending save(s). These are not included in confirmed balances yet.`:'');
  if(queue.length){
   const list=document.createElement('ul');
   queue.forEach(item=>{const row=document.createElement('li');row.textContent=`${item.label||item.request.action} · ${cash(item.request.amount||0)} · ${item.error||'Awaiting confirmation'}`;if(item.error){const remove=document.createElement('button');remove.textContent='Dismiss rejected entry';remove.onclick=async()=>{await feeWithLock(pendingKey,()=>localStorage.setItem(pendingKey,JSON.stringify(feeQueueRead(pendingKey).filter(x=>x.request.requestId!==item.request.requestId))));renderSchoolFees();};row.append(remove);}list.append(row);});msg.after(list);
  }
  function operation(button,build,done){
   let busy=false;
   button.onclick=async()=>{
    if(busy||!active())return;busy=true;button.disabled=true;
    try{
     const request={...build(),requestId:crypto.randomUUID()};
     await feeWithLock(pendingKey,()=>{const q=feeQueueRead(pendingKey);const names={classFee:'Class fee',reviseClass:'Class fee correction',cancelClass:'Class fee removal',edit:'Fee correction',cancel:'Fee removal',adjust:'Adjustment',payment:'Payment',void:'Receipt reversal'};const account=data.accounts.find(a=>a.id===request.accountId);q.push({request,label:(names[request.action]||request.action)+' — '+(account?account.studentName+' · '+account.term+' '+account.year:(classes.find(c=>c.id===request.classId)?.name||'')+' · '+(request.term||'')+' '+(request.year||''))});localStorage.setItem(pendingKey,JSON.stringify(q));});
     msg.textContent='Saved on this device; waiting for confirmation…';
     const results=await feeFlush(pendingKey,active);if(!active())return;
     if(results[request.requestId])await done(results[request.requestId]);else await renderSchoolFees();
    }catch(e){if(active())msg.textContent=e.message||String(e);}
    finally{busy=false;if(active())button.disabled=false;}
   };
  }
  host.querySelector('#feeRefresh').onclick=renderSchoolFees;
  operation(host.querySelector('#feeApply'),()=>({action:'classFee',classId:host.querySelector('#feeClass').value,term:host.querySelector('#feeTerm').value,year:host.querySelector('#feeYear').value,amount:cents(host.querySelector('#feeAmount').value)}),async result=>{await renderSchoolFees();if(isCurrentSession(session,user,school))document.getElementById('feeMessage').textContent=`Created ${result.created} pupil charges; ${result.skipped} existing charges kept.`;});
  for(const [buttonId,action] of [['feeClassEdit','reviseClass'],['feeClassCancel','cancelClass']])operation(host.querySelector('#'+buttonId),()=>{
   const classId=host.querySelector('#feeClass').value,term=host.querySelector('#feeTerm').value,year=host.querySelector('#feeYear').value;
   const accounts=data.accounts.filter(a=>a.classId===classId&&a.term===term&&a.year===year);
   const reason=host.querySelector('#feeClassReason').value.trim();if(!reason)throw Error('Enter a reason for the class fee change.');
   if(!confirm(`${action==='cancelClass'?'Cancel':'Update'} fees for ${accounts.length} pupil(s) in ${term} ${year}? Existing payments and history will be preserved.`))throw Error('Cancelled.');
   return {action,classId,term,year,reason,amount:action==='cancelClass'?0:cents(host.querySelector('#feeAmount').value),revisions:Object.fromEntries(accounts.map(a=>[a.id,a.revision]))};
  },renderSchoolFees);
  function draw(){
   const search=host.querySelector('#feeSearch').value.toLowerCase();
   const latest=Object.values(data.accounts.reduce((map,a)=>{if(!map[a.studentId]||(a.year+'__'+a.term)>(map[a.studentId].year+'__'+map[a.studentId].term))map[a.studentId]=a;return map;},{}));
   const accounts=latest.filter(a=>`${a.studentName} ${a.className} ${a.term} ${a.year}`.toLowerCase().includes(search));
   const selected=data.accounts.filter(a=>accounts.some(x=>x.studentId===a.studentId));
   const charged=selected.reduce((sum,a)=>sum+a.base+a.adjustment,0),paid=selected.reduce((sum,a)=>sum+a.paid,0);
   host.querySelector('#feeTotals').textContent=`${accounts.length} accounts · Charged ${cash(charged)} · Paid ${cash(paid)} · Outstanding ${cash(charged-paid)}`;
   host.querySelector('#feeRows').innerHTML=accounts.map(a=>`<tr><td>${esc(a.studentName)}<br><small>${esc(a.className)}${a.cancelled?' · Fee removed':''}</small></td><td>${esc(a.term)}<br>${esc(a.year)}</td><td>${cash(previousBalance(a))}</td><td>${cash(a.base+a.adjustment)}</td><td>${cash(previousBalance(a)+a.base+a.adjustment-a.paid)}</td><td><button type="button" data-account="${a.id}">Open</button></td></tr>`).join('')||'<tr><td colspan="6">No fees found. Set a standard class fee to begin.</td></tr>';
   host.querySelectorAll('[data-account]').forEach(b=>b.onclick=()=>openPupil(data.accounts.find(a=>a.id===b.dataset.account)));
  }
  function previousBalance(a){return data.accounts.filter(x=>x.studentId===a.studentId&&(x.year+'__'+x.term)<(a.year+'__'+a.term)).reduce((sum,x)=>sum+x.base+x.adjustment-x.paid,0);}
  function openPupil(a){
   const pane=host.querySelector('#feePupil'),payments=data.payments.filter(p=>data.accounts.some(x=>x.id===p.accountId&&x.studentId===a.studentId)).sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt));
   pane.innerHTML=`<label>View term<select id="feeViewTerm">${data.accounts.filter(x=>x.studentId===a.studentId).sort((x,y)=>(y.year+y.term).localeCompare(x.year+x.term)).map(x=>`<option value="${x.id}" ${x.id===a.id?'selected':''}>${esc(x.term)} · ${esc(x.year)}</option>`).join('')}</select></label><h3>${esc(a.studentName)} — ${esc(a.term)} ${esc(a.year)}</h3><p>Standard fee ${cash(a.base)} · Adjustments ${cash(a.adjustment)} · Previous balance ${cash(previousBalance(a))} · Total due ${cash(previousBalance(a)+a.base+a.adjustment-a.paid)}</p>
   <details><summary>Edit or remove this term’s fee</summary><label>New total charge (GH₵)<input id="feeNewCharge" type="number" min="0" step="0.01" value="${((a.base+a.adjustment)/100).toFixed(2)}"></label><label>Reason<input id="feeEditReason" maxlength="200" placeholder="Reason for correction"></label><button id="feeEditSave" type="button">Update fee</button><button id="feeCancel" type="button">Remove fee</button><p>Removing a fee cancels the charge and keeps its history. Void any payments first. Editing replaces the total charge, including previous adjustments.</p></details>
   <details><summary>Individual charge or discount</summary><p>Use a negative amount for a discount or scholarship, and a positive amount for an additional charge. For a different individual fee, enter the difference from the current charge.</p><label>Adjustment (GH₵)<input id="feeAdjustment" type="number" step="0.01"></label><label>Reason<input id="feeReason" maxlength="200" placeholder="Sibling discount, scholarship, transport…"></label><button id="feeAdjustSave" type="button">Save adjustment</button></details>
   <h4>Record payment</h4><label>Amount received (GH₵)<input id="feePaymentAmount" type="number" min="0.01" step="0.01"></label><label>Payment method<select id="feeMethod"><option>Cash</option><option>Mobile Money</option><option>Bank Transfer</option></select></label><label>Payer name<input id="feePayer" maxlength="200"></label><label>Transaction reference (optional)<input id="feeReference" maxlength="200"></label><button id="feePay" type="button" class="btn-primary">Record payment & receipt</button>
   <h4>Receipts</h4><div id="feeReceipts"></div><h4>Fee change history</h4><ul>${data.events.filter(e=>(e.accountId===a.id||e.accountIds?.includes(a.id))&&['adjust','edit','cancel','reviseClass','cancelClass'].includes(e.action)).map(e=>`<li>${esc(e.at.slice(0,10))}: ${cash(e.amount)} · ${esc(e.action)} — ${esc(e.reason)}</li>`).join('')||'<li>No fee changes.</li>'}</ul>`;
   pane.querySelector('#feeViewTerm').onchange=e=>openPupil(data.accounts.find(x=>x.id===e.target.value));
   operation(pane.querySelector('#feeEditSave'),()=>({action:'edit',accountId:a.id,revision:a.revision,amount:cents(pane.querySelector('#feeNewCharge').value),reason:pane.querySelector('#feeEditReason').value}),renderSchoolFees);
   operation(pane.querySelector('#feeCancel'),()=>{if(!confirm('Cancel this term’s fee? The history will be kept.'))throw Error('Cancelled.');return {action:'cancel',accountId:a.id,revision:a.revision,reason:pane.querySelector('#feeEditReason').value};},renderSchoolFees);
   operation(pane.querySelector('#feeAdjustSave'),()=>({action:'adjust',accountId:a.id,revision:a.revision,amount:cents(pane.querySelector('#feeAdjustment').value),reason:pane.querySelector('#feeReason').value}),renderSchoolFees);
   operation(pane.querySelector('#feePay'),()=>({action:'payment',accountId:a.id,amount:cents(pane.querySelector('#feePaymentAmount').value),method:pane.querySelector('#feeMethod').value,payer:pane.querySelector('#feePayer').value,reference:pane.querySelector('#feeReference').value}),async r=>{await renderSchoolFees();if(isCurrentSession(session,user,school))showFeeReceipt(r.payment);});
   const receipts=pane.querySelector('#feeReceipts');
   payments.forEach(p=>{
    const row=document.createElement('div'),label=document.createElement('p'),print=document.createElement('button');
    label.textContent=`${p.receipt} · ${cash(p.amount)} · ${p.method} · ${p.receivedAt.slice(0,10)}${p.voided?' · VOID: '+p.voidReason:''}`;print.textContent='View / Print receipt';print.onclick=()=>showFeeReceipt(p);row.append(label,print);
    if(!p.voided){const reason=document.createElement('input'),voidBtn=document.createElement('button');reason.placeholder='Reason for voiding this receipt';reason.setAttribute('aria-label','Void reason for '+p.receipt);voidBtn.textContent='Void receipt';row.append(reason,voidBtn);operation(voidBtn,()=>{if(!reason.value.trim())throw Error('Enter a reason for voiding.');if(!confirm('Void '+p.receipt+'? The pupil’s outstanding balance will increase by '+cash(p.amount)+'. The original receipt will remain in history.'))throw Error('Cancelled.');return {action:'void',accountId:p.accountId,paymentId:p.id,reason:reason.value};},renderSchoolFees);}
    receipts.append(row);
   });
   pane.scrollIntoView({behavior:'smooth',block:'start'});
  }
  host.querySelector('#feeSearch').oninput=draw;draw();
  host.querySelector('#feeExport').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({schoolId:school,exportedAt:new Date().toISOString(),...data},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='school-fees-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);};
 }catch(e){if(active())host.textContent='Unable to load fees: '+(e.message||e)+'. Reopen Fees & Receipts to retry.';}
}
function showFeeReceipt(p){
 if(!isHeadTeacher())return;
 const esc=escapeHtml,cash=n=>'GH₵ '+(n/100).toFixed(2),overlay=document.createElement('div');overlay.className='about-overlay';overlay.id='feeReceiptDialog';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','Fee receipt');
 overlay.innerHTML=`<div class="about-box"><h2>${esc(p.schoolName)}</h2><h3>${p.voided?'VOIDED RECEIPT':'PAYMENT RECEIPT'} · ${esc(p.receipt)}</h3><p>Date: ${esc(p.receivedAt.slice(0,10))}</p><p>Pupil: ${esc(p.studentName)}<br>Class: ${esc(p.className)}<br>${esc(p.term)} · ${esc(p.year)}</p><p>Received from: ${esc(p.payer)}<br>Method: ${esc(p.method)}<br>Reference: ${esc(p.reference||'—')}</p><p><strong>Amount received: ${cash(p.amount)}</strong></p><p>Balance after this payment: ${cash(p.balanceAfter)}</p>${p.voided?`<p>Void reason: ${esc(p.voidReason)}</p>`:''}<p>This receipt records a payment entered by the school.</p><button type="button" class="btn-primary" data-print>Print / Save as PDF</button><button type="button" class="btn-secondary" data-close>Close</button></div>`;
 overlay.querySelector('[data-print]').onclick=()=>window.print();overlay.querySelector('[data-close]').onclick=()=>overlay.remove();document.body.append(overlay);overlay.querySelector('[data-close]').focus();
}

new MutationObserver(()=>{if(!isHeadTeacher()||!sessionReady){document.getElementById('feeReceiptDialog')?.remove();const host=document.getElementById('feesWrap');if(host&&host.textContent)host.replaceChildren();}}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});

// Reconnect and restored sessions also drain pending saves when another page is open.
let feeBackgroundBusy=false;
setInterval(async()=>{
 if(feeBackgroundBusy||!sessionReady||!isHeadTeacher()||navigator.onLine===false)return;
 const school=currentSchoolId,user=currentUid,session=sessionGeneration,key='schoolhub_fee_queue_'+school+'_'+user;
 const active=()=>isCurrentSession(session,user,school)&&isHeadTeacher();
 try{
  const queued=feeQueueRead(key);if(!queued.length||queued[0].error)return;
  feeBackgroundBusy=true;await feeFlush(key,active);
  if(active()){const data=await safetyCall('getSchoolFees',{});if(active())localStorage.setItem('schoolhub_fee_cache_'+school+'_'+user,JSON.stringify(data));}
 }catch(e){/* Keep pending entries on this device for the next attempt. */}finally{feeBackgroundBusy=false;}
},30000);

// Only class balances are exposed to report users, never receipts or payer details.
async function loadReportFeeBalances(classId,settings){
 if(!FIREBASE_ENABLED||isActiveGuest())return null;
 const school=currentSchoolId,user=currentUid,session=sessionGeneration;
 const key='schoolhub_report_fees_'+school+'_'+user+'_'+classId+'_'+settings.currentYear+'_'+settings.currentTerm;
 if(navigator.onLine===false){const saved=localStorage.getItem(key);if(saved)return {...JSON.parse(saved),offline:true};throw Error('Connect once to load fee balances for this class before printing offline.');}
 const data=await safetyCall('getReportFeeBalances',{classId,term:settings.currentTerm,year:settings.currentYear});
 if(!isCurrentSession(session,user,school))throw Error('Account changed. Reopen this page.');
 localStorage.setItem(key,JSON.stringify(data));return data;
}
function reportFeeRemarks(remarks,studentId,fees){
 return fees&&Object.prototype.hasOwnProperty.call(fees.balances,studentId)?{...remarks,feesDue:(fees.balances[studentId]/100).toFixed(2)}:remarks;
}
async function refreshRemarksFeeBalance(student,classId,settings,card){
 if(!FIREBASE_ENABLED||isActiveGuest())return;
 const input=card.querySelector('.rm-fees'),note=document.createElement('small');
 input.readOnly=true;input.value='';note.textContent='Loading confirmed fee balance…';input.after(note);
 try{const fees=await loadReportFeeBalances(classId,settings);if(!card.isConnected)return;
 const managed=Object.prototype.hasOwnProperty.call(fees.balances,student.id);
 input.value=managed?(fees.balances[student.id]/100).toFixed(2):input.dataset.manual||'';input.readOnly=managed;
 note.textContent=managed?(fees.offline?'Last confirmed balance saved on this device.':'From Fees & Receipts, including previous unpaid balances. Update fees or payments there.'):'No fee account for this period. You may enter an amount manually.';
 }catch(e){if(card.isConnected){input.value=input.dataset.manual||'';note.textContent='Fee balance unavailable. '+(e.message||e);}}
}
