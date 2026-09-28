/* Fees are server-authoritative and deliberately never enter the offline sync queue. */
let feeViewGeneration=0;
async function renderSchoolFees(){
 const host=document.getElementById('feesWrap'),generation=++feeViewGeneration,school=currentSchoolId,user=currentUid,session=sessionGeneration;
 const active=()=>generation===feeViewGeneration&&isCurrentSession(session,user,school)&&isHeadTeacher();
 if(!isHeadTeacher()||!FIREBASE_ENABLED){host.textContent='Sign in as Head Teacher to manage fees.';return;}
 const pendingKey='schoolhub_fee_pending_'+school+'_'+user;
 host.textContent='Loading fees and receipts…';
 try{
  const data=await safetyCall('getSchoolFees',{});if(!active())return;
  const settings=DB.get(KEYS.settings,{}),classes=DB.get(KEYS.classes,[]),esc=escapeHtml;
  const cash=n=>'GH₵ '+(Number(n||0)/100).toFixed(2);
  const cents=value=>{if(!/^-?\d+(\.\d{1,2})?$/.test(value.trim()))throw Error('Enter an amount with at most two decimal places.');return Math.round(Number(value)*100);};
  host.innerHTML=`<p>Record money received by the school. This page does not collect or transfer money. Internet access is required to save.</p>
  <details><summary>Set a standard class fee</summary><p>Creates a charge for each active pupil for the selected term. Existing pupil charges stay unchanged; use an individual adjustment to correct them. Apply again to include newly enrolled pupils.</p>
  <label>Class<select id="feeClass">${classes.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
  <label>Term<select id="feeTerm">${['Term 1','Term 2','Term 3'].map(t=>`<option ${t===settings.currentTerm?'selected':''}>${t}</option>`).join('')}</select></label>
  <label>Academic year<input id="feeYear" value="${esc(settings.currentYear||'')}" placeholder="2026/2027"></label>
  <label>Fee per pupil (GH₵)<input id="feeAmount" type="number" min="0" step="0.01"></label><button id="feeApply" type="button" class="btn-primary">Apply class fee</button></details>
  <p id="feeMessage" role="status"></p><button id="feeRefresh" type="button" class="btn-secondary">Refresh balances</button>
  <h3>Pupil balances</h3><p>Earlier unpaid terms remain here as arrears. They are not added again to a new term’s charge.</p>
  <label>Search pupil, class or term<input id="feeSearch" type="search" placeholder="Name, class, term or year"></label>
  <div id="feeTotals"></div><div class="table-scroll"><table><thead><tr><th>Pupil / class</th><th>Term</th><th>Charged</th><th>Paid</th><th>Balance</th><th></th></tr></thead><tbody id="feeRows"></tbody></table></div>
  <div id="feePupil"></div><button id="feeExport" type="button" class="btn-secondary">Export fees backup (JSON)</button>`;
  const msg=host.querySelector('#feeMessage');
  const clearPending=()=>localStorage.removeItem(pendingKey);
  const definitive=e=>/invalid-argument|failed-precondition|aborted|permission-denied|unauthenticated|not-found|already-exists/.test(e.code||'');
  const savedPending=localStorage.getItem(pendingKey);
  if(savedPending){
   msg.textContent='An earlier save needs confirmation. Check it before entering another fee or payment.';
   const retry=document.createElement('button');retry.textContent='Check earlier save';retry.type='button';msg.after(retry);
   retry.onclick=async()=>{retry.disabled=true;try{await safetyCall('updateSchoolFees',JSON.parse(savedPending));clearPending();if(active())await renderSchoolFees();}catch(e){if(definitive(e))clearPending();if(active()){msg.textContent=e.message||String(e);retry.disabled=false;}}};
  }

  function operation(button,build,done){
   let pending=null,busy=false;
   button.onclick=async()=>{
    if(busy||!active())return;busy=true;button.disabled=true;
    try{
     if(!pending){if(localStorage.getItem(pendingKey))throw Error('Check the earlier save or refresh before entering another transaction.');pending={...build(),requestId:crypto.randomUUID()};localStorage.setItem(pendingKey,JSON.stringify(pending));}
     msg.textContent='Saving…';const result=await safetyCall('updateSchoolFees',pending);clearPending();pending=null;
     if(!active())return;msg.textContent='Saved.';await done(result);
    }catch(e){if(active())msg.textContent=(e.message||String(e))+' You may retry; the same operation will not be duplicated.';
     // Keep the exact request on ambiguous network failures. Validation errors may be corrected.
     if(definitive(e)){clearPending();pending=null;}
    }finally{busy=false;if(active())button.disabled=false;}
   };
  }
  host.querySelector('#feeRefresh').onclick=renderSchoolFees;
  operation(host.querySelector('#feeApply'),()=>({action:'classFee',classId:host.querySelector('#feeClass').value,term:host.querySelector('#feeTerm').value,year:host.querySelector('#feeYear').value,amount:cents(host.querySelector('#feeAmount').value)}),async result=>{await renderSchoolFees();if(isCurrentSession(session,user,school))document.getElementById('feeMessage').textContent=`Created ${result.created} pupil charges; ${result.skipped} existing charges kept.`;});
  function draw(){
   const search=host.querySelector('#feeSearch').value.toLowerCase();
   const accounts=data.accounts.filter(a=>`${a.studentName} ${a.className} ${a.term} ${a.year}`.toLowerCase().includes(search));
   const charged=accounts.reduce((sum,a)=>sum+a.base+a.adjustment,0),paid=accounts.reduce((sum,a)=>sum+a.paid,0);
   host.querySelector('#feeTotals').textContent=`${accounts.length} accounts · Charged ${cash(charged)} · Paid ${cash(paid)} · Outstanding ${cash(charged-paid)}`;
   host.querySelector('#feeRows').innerHTML=accounts.map(a=>`<tr><td>${esc(a.studentName)}<br><small>${esc(a.className)}</small></td><td>${esc(a.term)}<br>${esc(a.year)}</td><td>${cash(a.base+a.adjustment)}</td><td>${cash(a.paid)}</td><td>${cash(a.base+a.adjustment-a.paid)}</td><td><button type="button" data-account="${a.id}">Open</button></td></tr>`).join('')||'<tr><td colspan="6">No fees found. Set a standard class fee to begin.</td></tr>';
   host.querySelectorAll('[data-account]').forEach(b=>b.onclick=()=>openPupil(data.accounts.find(a=>a.id===b.dataset.account)));
  }
  function openPupil(a){
   const pane=host.querySelector('#feePupil'),payments=data.payments.filter(p=>p.accountId===a.id).sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt));
   pane.innerHTML=`<h3>${esc(a.studentName)} — ${esc(a.term)} ${esc(a.year)}</h3><p>Standard fee ${cash(a.base)} · Adjustments ${cash(a.adjustment)} · Outstanding ${cash(a.base+a.adjustment-a.paid)}</p>
   <details><summary>Individual charge or discount</summary><p>Use a negative amount for a discount or scholarship, and a positive amount for an additional charge. For a different individual fee, enter the difference from the current charge.</p><label>Adjustment (GH₵)<input id="feeAdjustment" type="number" step="0.01"></label><label>Reason<input id="feeReason" maxlength="200" placeholder="Sibling discount, scholarship, transport…"></label><button id="feeAdjustSave" type="button">Save adjustment</button></details>
   <h4>Record payment</h4><label>Amount received (GH₵)<input id="feePaymentAmount" type="number" min="0.01" step="0.01"></label><label>Payment method<select id="feeMethod"><option>Cash</option><option>Mobile Money</option><option>Bank Transfer</option></select></label><label>Payer name<input id="feePayer" maxlength="200"></label><label>Transaction reference (optional)<input id="feeReference" maxlength="200"></label><button id="feePay" type="button" class="btn-primary">Record payment & receipt</button>
   <h4>Receipts</h4><div id="feeReceipts"></div><h4>Adjustment history</h4><ul>${data.events.filter(e=>e.accountId===a.id&&e.action==='adjust').map(e=>`<li>${esc(e.at.slice(0,10))}: ${cash(e.amount)} — ${esc(e.reason)}</li>`).join('')||'<li>No individual adjustments.</li>'}</ul>`;
   operation(pane.querySelector('#feeAdjustSave'),()=>({action:'adjust',accountId:a.id,revision:a.revision,amount:cents(pane.querySelector('#feeAdjustment').value),reason:pane.querySelector('#feeReason').value}),renderSchoolFees);
   operation(pane.querySelector('#feePay'),()=>({action:'payment',accountId:a.id,amount:cents(pane.querySelector('#feePaymentAmount').value),method:pane.querySelector('#feeMethod').value,payer:pane.querySelector('#feePayer').value,reference:pane.querySelector('#feeReference').value}),async r=>{await renderSchoolFees();if(isCurrentSession(session,user,school))showFeeReceipt(r.payment);});
   const receipts=pane.querySelector('#feeReceipts');
   payments.forEach(p=>{
    const row=document.createElement('div'),label=document.createElement('p'),print=document.createElement('button');
    label.textContent=`${p.receipt} · ${cash(p.amount)} · ${p.method} · ${p.receivedAt.slice(0,10)}${p.voided?' · VOID: '+p.voidReason:''}`;print.textContent='View / Print receipt';print.onclick=()=>showFeeReceipt(p);row.append(label,print);
    if(!p.voided){const reason=document.createElement('input'),voidBtn=document.createElement('button');reason.placeholder='Reason for voiding this receipt';reason.setAttribute('aria-label','Void reason for '+p.receipt);voidBtn.textContent='Void receipt';row.append(reason,voidBtn);operation(voidBtn,()=>{if(!reason.value.trim())throw Error('Enter a reason for voiding.');if(!confirm('Void '+p.receipt+'? The pupil’s outstanding balance will increase by '+cash(p.amount)+'. The original receipt will remain in history.'))throw Error('Cancelled.');return {action:'void',accountId:a.id,paymentId:p.id,reason:reason.value};},renderSchoolFees);}
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
