/* School operations: confirmed balances, scoped durable requests, server-owned history. */
let operationsState=null,operationsStateContext=null,operationsLoad=0,operationsBusy=false;
const operationsLocks=new Map();
const OPERATIONS_CATEGORIES=Object.freeze(["Teaching & Learning Materials","Stationery & Office Supplies","Furniture","ICT & Electrical Equipment","Science/Technical Equipment","Sports & PE Equipment","Cleaning & Sanitation Supplies","Health/SHEP & First Aid","Library Materials","Maintenance & Repairs","Administrative Equipment","School Feeding/Kitchen","Uniforms/School Supplies","Consumables/General Supplies"]);
function operationsCategoryOptions(current=''){
 const options=[['','Select category'],...OPERATIONS_CATEGORIES.map(value=>[value,value])];
 if(current&&!OPERATIONS_CATEGORIES.includes(current))options.push([current,current+' (saved category)']);
 return options;
}
function operationsSession(){return {uid:currentUid,school:currentSchoolId,generation:sessionGeneration,head:isHeadTeacher()};}
function operationsContextMatches(s){return !!s&&s.uid&&s.school&&isCurrentSession(s.generation,s.uid,s.school)&&sessionReady&&currentStatus==='active'&&s.head===isHeadTeacher();}
function operationsActive(s){return s.uid&&s.school&&isCurrentSession(s.generation,s.uid,s.school)&&sessionReady&&sessionDataReady&&currentStatus==='active'&&s.head===isHeadTeacher();}
function operationsQueueKey(s=operationsSession()){return 'schoolhub_operations_queue_'+s.school+'_'+s.uid;}
function operationsCacheKey(s){return 'schoolhub_operations_cache_'+s.school+'_'+s.uid+'_'+(s.head?'head':'teacher');}
function operationsQueueRead(key=operationsQueueKey()){const raw=localStorage.getItem(key);if(!raw)return [];const value=JSON.parse(raw);if(!Array.isArray(value))throw Error('Pending operations need recovery. Do not clear site data.');return value;}
function hasPendingOperationsSync(){try{return !!currentUid&&!!currentSchoolId&&operationsQueueRead().length>0;}catch(_){return true;}}
function operationsPendingCount(){try{return operationsQueueRead().length;}catch(_){return 1;}}
function operationsHasErrors(){try{return operationsQueueRead().some(x=>x.error);}catch(_){return true;}}
function operationsWithLock(key,fn){if(navigator.locks)return navigator.locks.request(key,fn);const p=(operationsLocks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);operationsLocks.set(key,p);return p;}
function operationsMoney(value){const text=String(value??'').trim();if(!/^\d+(\.\d{1,2})?$/.test(text))throw Error('Enter an amount with at most two decimal places.');const n=Math.round(Number(text)*100);if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Amount is too large.');return n;}
function operationsQuantity(value,signed=false){const text=String(value??'').trim();if(!(signed?/^-?\d+(\.\d{1,3})?$/:/^\d+(\.\d{1,3})?$/).test(text))throw Error('Enter a quantity with at most three decimal places.');const n=Math.round(Number(text)*1000);if(!Number.isSafeInteger(n)||Math.abs(n)>1000000000)throw Error('Quantity is too large.');return n;}
const operationsCash=n=>'GH₵ '+(Number(n||0)/100).toFixed(2);
const operationsQty=n=>String(Number(n||0)/1000);
function operationsPermanent(e){return /(?:^|\/)(invalid-argument|failed-precondition|aborted|permission-denied|unauthenticated|not-found|already-exists)$/.test(String(e.code||''));}
async function flushPendingSchoolOperationWrites(){
 const s=operationsSession(),key=operationsQueueKey(s);if(!operationsActive(s)||navigator.onLine===false||offlineAuthenticatedMode)return false;
 return operationsWithLock(key,async()=>{
  if(typeof reconcileWorkerSyncAcks==='function')await reconcileWorkerSyncAcks(key);
  while(operationsActive(s)&&navigator.onLine!==false&&!offlineAuthenticatedMode){
   const queue=operationsQueueRead(key),entry=queue[0];if(!entry||entry.error)break;
   try{await safetyCall('updateSchoolOperations',entry.request);if(!operationsActive(s))break;const latest=operationsQueueRead(key);localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.request.requestId!==entry.request.requestId)));localStorage.removeItem(operationsCacheKey(s));}
   catch(e){if(operationsPermanent(e)&&operationsActive(s)){const latest=operationsQueueRead(key),found=latest.find(x=>x.request.requestId===entry.request.requestId);if(found)found.error=e.message;localStorage.setItem(key,JSON.stringify(latest));}break;}
  }
  if(operationsActive(s)&&typeof stageWorkerOperationsQueue==='function')await stageWorkerOperationsQueue(true);
  if(typeof updateOfflineModeBanner==='function')updateOfflineModeBanner();return operationsQueueRead(key).length===0;
 });
}
async function operationsSubmit(action,data,stableRequestId){
 if(operationsBusy)throw Error('Wait for the current save.');const s=operationsSession();if(!operationsActive(s))throw Error('Sign in to your active school first.');
 operationsBusy=true;
 try{
 if(navigator.onLine!==false&&offlineAuthenticatedMode&&typeof revalidateAndSyncAfterReconnect==='function')await revalidateAndSyncAfterReconnect();
 if(!operationsActive(s))throw Error('Your school account needs verification before this save.');
 if(navigator.onLine===false||offlineAuthenticatedMode)throw Error('Connect to the internet to confirm this save. Your entries remain here.');
  const key=operationsQueueKey(s);await operationsWithLock(key,async()=>{
   if(operationsQueueRead(key).length)throw Error('Resolve the pending save before entering another transaction.');
   const request={...data,action,requestId:stableRequestId||crypto.randomUUID(),expectedUid:s.uid,expectedSchoolId:s.school};localStorage.setItem(key,JSON.stringify([{request}]));
  });
  if(typeof requestSchoolHubBackgroundSync==='function')requestSchoolHubBackgroundSync('operations-save');
  await flushPendingSchoolOperationWrites();
  if(!operationsActive(s))return;
  const pending=operationsQueueRead();if(pending.length)throw Error(pending[0].error||'Save is not yet confirmed. Your request is retained; retry it instead of entering it again.');
 }finally{operationsBusy=false;}
}
async function renderSchoolOperations(quiet=false){
 const host=document.getElementById('operationsWrap'),s=operationsSession();if(!host)return;
 if(operationsStateContext&&!operationsContextMatches(operationsStateContext)){operationsState=null;operationsStateContext=null;document.getElementById('operationsDialog')?.remove();host.replaceChildren();}
 const load=++operationsLoad;
 if(!operationsActive(s)||!FIREBASE_ENABLED){if(FIREBASE_ENABLED&&operationsState&&operationsContextMatches(operationsStateContext)){const status=host.querySelector('[data-ops-status]');if(status)status.textContent='Checking school data. Saved records remain visible; actions resume after verification.';return;}host.textContent='Sign in to your active school to use stores and school property records.';return;}
 try{operationsQueueRead();}catch(e){host.textContent=e.message;return;}
 if(!s.head)localStorage.removeItem('schoolhub_operations_cache_'+s.school+'_'+s.uid+'_head');
 const key=operationsCacheKey(s),cached=localStorage.getItem(key),retained=operationsState&&operationsContextMatches(operationsStateContext);let data=retained?operationsState:null;
 try{if(!data&&cached){data=JSON.parse(cached);if(data.role!==(s.head?'headteacher':'teacher'))data=null;}}catch(_){}
 const current=()=>load===operationsLoad&&operationsActive(s);
 if(data){operationsState=data;operationsStateContext=s;if(!retained||!host.querySelector('[data-ops-status]'))operationsRender(data,s,host,true);else if(!quiet)host.querySelector('[data-ops-status]').textContent='Updating school operations… Saved records remain visible.';}else host.textContent='Loading school operations…';
 if(navigator.onLine===false||offlineAuthenticatedMode){if(data){const status=host.querySelector('[data-ops-status]');if(status)status.textContent='Saved records shown. Connect and verify to refresh or submit.';}if(!data)host.textContent='Connect once to load the stock catalogue. Changes require a verified online account.';return;}
 try{
  await flushPendingSchoolOperationWrites();if(!current())return;
  data=await safetyCall('getSchoolOperations',{expectedUid:s.uid,expectedSchoolId:s.school});if(!current())return;
  if(data.role!==(s.head?'headteacher':'teacher')){localStorage.removeItem(key);operationsState=null;operationsStateContext=null;host.textContent='Your account role changed. Reopen SchoolHub to refresh your access.';return;}
  const changed=JSON.stringify(operationsState)!==JSON.stringify(data);localStorage.setItem(key,JSON.stringify(data));operationsState=data;operationsStateContext=s;if(changed||!host.querySelector('[data-ops-status]'))operationsRender(data,s,host,false);else host.querySelector('[data-ops-status]').textContent='Confirmed school records. Stock and payment changes require internet.';
 }catch(e){if(current()){if(!data)host.textContent=e.message||'Could not load school operations.';else host.querySelector('[data-ops-status]').textContent='Cached records shown. '+(e.message||'Reconnect to refresh.');}}
}
function operationsSearchMatches(text,query){
 const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
 const haystack=normalize(text),terms=normalize(query).split(' ').filter(Boolean);
 return terms.every(term=>haystack.includes(term));
}
function operationsApplySearch(host,query){
 host.querySelectorAll('[data-ops-panel]').forEach(panel=>{
  const rows=[...panel.querySelectorAll('tbody tr')];let shown=0;
  rows.forEach(row=>{
   const text=[...row.cells].slice(0,-1).map(cell=>cell.textContent).join(' ');
   row.hidden=!operationsSearchMatches(text,query);if(!row.hidden)shown++;
  });
  const status=panel.querySelector('[data-ops-search-status]');
  if(status)status.textContent=rows.length?(shown?shown+' of '+rows.length+' records shown.':'No matching records. Try another code or name.'):'No records yet.';
 });
}
function operationsRender(data,s,host,cached){
 const previousSearch=host.querySelector('[data-ops-search]'),query=previousSearch?.value||'';
 const tablePositions=[...host.querySelectorAll('.operations-table-scroll')].map(node=>({left:node.scrollLeft,top:node.scrollTop}));
 const searchFocused=!!previousSearch&&document.activeElement===previousSearch;
 const selection=searchFocused?[previousSearch.selectionStart,previousSearch.selectionEnd]:null;
 const esc=escapeHtml,queue=operationsQueueRead(),tabs=s.head?[['stock','Stores & Inventory'],['requests','Stock Requests'],['assets','Assets'],['liabilities','Liabilities'],['history','History']]:[['stock','Stock Catalogue'],['requests','My Requests']];
 const tabKey='schoolhub_operations_tab_'+s.school+'_'+s.uid;let selected=localStorage.getItem(tabKey)||'stock';if(!tabs.some(x=>x[0]===selected))selected='stock';
 const activeItems=data.items.filter(x=>x.active),low=activeItems.filter(x=>x.quantityMilli<=x.minimumMilli),liabilities=data.liabilities||[],outstanding=liabilities.reduce((sum,x)=>sum+x.amount-x.paid,0),today=[new Date().getFullYear(),String(new Date().getMonth()+1).padStart(2,'0'),String(new Date().getDate()).padStart(2,'0')].join('-'),overdue=liabilities.filter(x=>x.amount>x.paid&&x.dueOn<today);
 const button=(action,label,id='',extra='')=>`<button type="button" class="btn-secondary" data-ops-action="${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
 const table=(headers,rows)=>`<p class="hint operations-search-status" data-ops-search-status role="status" aria-live="polite"></p>`+(rows.length?`<p class="hint operations-table-hint">Scroll sideways for more columns. Headings and the first column stay visible.</p><div class="table-scroll operations-table-scroll" tabindex="0" role="region" aria-label="School records: scroll to see all columns"><table class="grades-table operations-table"><thead><tr>${headers.map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'<p class="empty">No records yet.</p>');
 const stockRows=data.items.map(x=>[esc(x.code),esc(x.name)+(x.active?'':' <small>Archived</small>'),esc(x.category),esc(operationsQty(x.quantityMilli)+' '+x.unit),...(s.head?[x.quantityMilli<=x.minimumMilli&&x.active?'Low stock':'—',operationsCash(x.unitCost)]:[]),button('viewItem','View',x.id)+(s.head?button('editItem','Edit',x.id):x.active?button('requestStock','Request',x.id):'')]);
 const requestRows=[...data.requests].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(x=>[esc(x.itemName),esc(operationsQty(x.quantityMilli)+' '+x.unit),esc(x.purpose),s.head?esc(x.requestedBy):esc(x.createdAt.slice(0,10)),esc(x.status),esc(x.decisionNote||''),button('viewRequest','View',x.id)+(x.status==='pending'?(s.head?button('approveRequest','Approve & issue',x.id)+button('rejectRequest','Reject',x.id):button('cancelRequest','Cancel',x.id)):'')]);
 host.innerHTML=`<div class="operations-wrap"><p data-ops-status class="hint">${cached?'Cached records — connect to refresh.':'Confirmed school records.'} Stock and payment changes require internet.</p><div class="operations-toolbar">${button('refresh','Refresh')}${button('export','Export this section')}</div>${queue.length?`<div class="operations-pending" role="status"><strong>${queue[0].error?'Save needs review':'Save awaiting confirmation'}</strong><p>${esc(queue[0].error||'The same request will be retried without duplicating stock or payments.')}</p>${button('retry','Retry pending save')}${queue[0].error?button('discard','Discard rejected save'):''}</div>`:''}
 ${s.head?`<div class="operations-summary"><div><strong>${activeItems.length}</strong><span>Active stock items</span></div><div><strong>${low.length}</strong><span>Low stock</span></div><div><strong>${operationsCash(data.assets.filter(x=>x.status!=='disposed').reduce((n,x)=>n+x.value,0))}</strong><span>Recorded asset value</span></div><div><strong>${operationsCash(outstanding)}</strong><span>Outstanding liabilities · ${overdue.length} overdue</span></div></div>`:''}
 <div class="operations-tabs" role="tablist" aria-label="School operations">${tabs.map(([id,title])=>`<button type="button" role="tab" aria-selected="${id===selected}" data-ops-tab="${id}" aria-controls="operations-${id}">${title}</button>`).join('')}</div>
 <div class="operations-search"><label for="operationsSearch">Search this section</label><div><input type="search" id="operationsSearch" data-ops-search value="${esc(query)}" placeholder="Search codes, items or names…" autocomplete="off"><button type="button" class="btn-secondary" data-ops-clear-search>Clear</button></div></div>
 <section role="tabpanel" id="operations-stock" data-ops-panel="stock" ${selected!=='stock'?'hidden':''}><h3>${s.head?'Stores & Inventory':'Stock Catalogue'}</h3>${s.head?`<div class="operations-toolbar">${button('createItem','Add stock item')}${button('receive','Receive stock')}${button('issue','Issue stock')}${button('adjust','Correct stock')}</div><p class="hint">Quantities support three decimal places. Record each delivery, issue or correction with a reference.</p>`:''}${table(s.head?['Code','Item','Category','On hand','Status','Unit cost','Actions']:['Code','Item','Category','Available','Actions'],stockRows)}</section>
 <section role="tabpanel" id="operations-requests" data-ops-panel="requests" ${selected!=='requests'?'hidden':''}><h3>${s.head?'Stock Requests':'My Requests'}</h3>${!s.head?button('requestStock','New stock request'):''}${!s.head?'<div data-stock-drafts></div>':''}<p class="hint">Approval issues the requested quantity once. Requests do not reserve stock until approved.</p>${table(['Item','Quantity','Purpose',s.head?'Requested by':'Date','Status','Decision','Actions'],requestRows)}</section>
 ${s.head?`<section role="tabpanel" id="operations-assets" data-ops-panel="assets" ${selected!=='assets'?'hidden':''}><h3>Assets</h3>${button('createAsset','Register asset')}<p class="hint">Track furniture, equipment and other school property by asset tag, location and custodian. Recorded values are entered by the school.</p>${table(['Tag','Asset','Location','Custodian','Condition','Status','Recorded value','Actions'],data.assets.map(x=>[esc(x.code),esc(x.name),esc(x.location),esc(x.custodian),esc(x.condition),esc(x.status.replace('_',' ')),operationsCash(x.value),button('viewAsset','View',x.id)+button('editAsset','Edit',x.id)]))}</section>
 <section role="tabpanel" id="operations-liabilities" data-ops-panel="liabilities" ${selected!=='liabilities'?'hidden':''}><h3>Liabilities</h3>${button('createLiability','Add supplier bill / debt')}<p class="hint">Recording a payment updates this register; it does not transfer money.</p>${table(['Supplier / creditor','Description','Due','Amount owed','Paid','Balance','Actions'],liabilities.map(x=>[esc(x.creditor),esc(x.description),esc(x.dueOn)+(x.amount>x.paid&&x.dueOn<today?' · Overdue':''),operationsCash(x.amount),operationsCash(x.paid),operationsCash(x.amount-x.paid),button('viewLiability','View',x.id)+button('editLiability','Edit',x.id)+(x.amount>x.paid?button('settle','Record payment',x.id):'Settled')]))}</section>
 <section role="tabpanel" id="operations-history" data-ops-panel="history" ${selected!=='history'?'hidden':''}><h3>Recent History</h3><p class="hint">Latest 150 confirmed management events. Earlier history remains on the server.</p>${table(['Date','Action','Record','Quantity / amount','Reference','Actions'],data.history.map(x=>[esc(x.createdAt.slice(0,19).replace('T',' ')),esc(x.summary),esc(x.entityName),x.quantityMilli!==undefined?esc(operationsQty(x.quantityMilli)):x.amount!==undefined?operationsCash(x.amount):'—',esc(x.reason||''),button('viewHistory','View',x.id)+(x.action==='settle'?button('reverseSettlement','Reverse payment',x.entityId,`data-payment="${esc(x.paymentId)}"`):'')]))}</section>`:''}</div>`;
 [...host.querySelectorAll('.operations-table-scroll')].forEach((node,i)=>{if(tablePositions[i]){node.scrollLeft=tablePositions[i].left;node.scrollTop=tablePositions[i].top;}});
 operationsRenderDrafts(s);
 const search=host.querySelector('[data-ops-search]');
 search.oninput=()=>{if(operationsActive(s))operationsApplySearch(host,search.value);};
 host.querySelector('[data-ops-clear-search]').onclick=()=>{if(!operationsActive(s))return;search.value='';operationsApplySearch(host,'');search.focus();};
 operationsApplySearch(host,query);
 if(searchFocused){search.focus();if(selection[0]!==null)search.setSelectionRange(...selection);}
 host.querySelectorAll('[data-ops-tab]').forEach(btn=>btn.onclick=()=>{localStorage.setItem(tabKey,btn.dataset.opsTab);host.querySelectorAll('[data-ops-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===btn)));host.querySelectorAll('[data-ops-panel]').forEach(panel=>panel.hidden=panel.dataset.opsPanel!==btn.dataset.opsTab);});
 host.querySelectorAll('[data-ops-action]').forEach(btn=>btn.onclick=async()=>{
  if(!operationsActive(s))return;const action=btn.dataset.opsAction;
  try{
   if(action==='refresh'||action==='retry'){await renderSchoolOperations();return;}
   if(action==='export'){operationsExport(data,localStorage.getItem(tabKey)||'stock');return;}
   if(action==='discard'){if(!confirm('Discard this rejected save? Confirmed school records will remain unchanged.'))return;await operationsWithLock(operationsQueueKey(s),async()=>{const q=operationsQueueRead();if(q[0]?.error)localStorage.setItem(operationsQueueKey(s),'[]');});if(typeof stageWorkerOperationsQueue==='function')await stageWorkerOperationsQueue();await renderSchoolOperations();return;}
   if(action.startsWith('view')){operationsViewRecord(action,btn.dataset.id);return;}
   operationsOpenForm(action,btn.dataset.id,btn.dataset.payment);
  }catch(e){host.querySelector('[data-ops-status]').textContent=e.message;}
 });
}
function operationsRecordDetails(kind,record,head){
 const quantity=n=>operationsQty(n)+' '+(record.unit||'');
 if(kind==='viewItem')return [['Stock code',record.code],['Item',record.name],['Category',record.category],['Unit',record.unit],['On hand',quantity(record.quantityMilli)],['Status',record.active?'Active':'Archived'],...(head?[['Low-stock threshold',quantity(record.minimumMilli)],['Unit cost',operationsCash(record.unitCost)]]:[])];
 if(kind==='viewRequest')return [['Item',record.itemName],['Quantity',quantity(record.quantityMilli)],['Purpose',record.purpose],['Requested by',record.requestedBy],['Date',record.createdAt],['Status',record.status],['Decision note',record.decisionNote]];
 if(!head)return [];
 if(kind==='viewAsset')return [['Asset tag',record.code],['Asset',record.name],['Category',record.category],['Acquisition cost',operationsCash(record.cost)],['Recorded value',operationsCash(record.value)],['Purchase date',record.purchasedOn],['Location',record.location],['Custodian',record.custodian],['Condition',record.condition],['Status',(record.status||'').replaceAll('_',' ')]];
 if(kind==='viewLiability')return [['Supplier / creditor',record.creditor],['Description',record.description],['Invoice reference',record.reference],['Due date',record.dueOn],['Amount owed',operationsCash(record.amount)],['Paid',operationsCash(record.paid)],['Balance',operationsCash(record.amount-record.paid)]];
 if(kind==='viewHistory')return [['Date',record.createdAt],['Action',record.summary],['Record',record.entityName],...(record.quantityMilli!==undefined?[['Quantity',operationsQty(record.quantityMilli)]]:[]),...(record.amount!==undefined?[['Amount',operationsCash(record.amount)]]:[]),['Reference / reason',record.reason]];
 return [];
}
function operationsViewRecord(kind,recordId){
 const s=operationsSession(),data=operationsState;
 if(!operationsActive(s)||!data||(operationsStateContext&&!operationsContextMatches(operationsStateContext)))return;
 if(!s.head&&!['viewItem','viewRequest'].includes(kind))return;
 const collections={viewItem:'items',viewRequest:'requests',viewAsset:'assets',viewLiability:'liabilities',viewHistory:'history'};
 const record=(data[collections[kind]]||[]).find(x=>x.id===recordId);if(!record)return;
 if(!s.head&&kind==='viewRequest'&&record.createdBy!==s.uid)return;
 const fields=operationsRecordDetails(kind,record,s.head);if(!fields.length)return;
 const titles={viewItem:'Stock item details',viewRequest:'Stock request details',viewAsset:'Asset details',viewLiability:'Liability details',viewHistory:'History details'};
 const actions=[];
 if(s.head&&kind==='viewItem')actions.push(['editItem','Edit'],...(record.active?[['receive','Receive stock'],['issue','Issue stock'],['adjust','Correct stock']]:[]));
 if(!s.head&&kind==='viewItem'&&record.active)actions.push(['requestStock','Request stock']);
 if(s.head&&kind==='viewAsset')actions.push(['editAsset','Edit']);
 if(s.head&&kind==='viewLiability')actions.push(['editLiability','Edit'],...(record.amount>record.paid?[['settle','Record payment']]:[]));
 if(kind==='viewRequest'&&record.status==='pending')actions.push(...(s.head?[['approveRequest','Approve & issue'],['rejectRequest','Reject']]:[['cancelRequest','Cancel request']]));
 document.getElementById('operationsDialog')?.remove();const origin=document.activeElement,esc=escapeHtml,overlay=document.createElement('div');overlay.id='operationsDialog';overlay.className='about-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label',titles[kind]);
 overlay.innerHTML=`<div class="about-box operations-dialog"><h2>${esc(titles[kind])}</h2><dl class="operations-details">${fields.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value===undefined||value===null||value===''?'—':value)}</dd></div>`).join('')}</dl><div class="operations-toolbar">${actions.map(([action,label])=>`<button type="button" class="btn-secondary" data-detail-action="${action}">${esc(label)}</button>`).join('')}<button type="button" class="btn-secondary" data-close data-dismiss-ui>Close</button></div></div>`;
 document.body.append(overlay);const close=()=>{overlay.remove();if(origin?.isConnected)origin.focus();};overlay.querySelector('[data-close]').onclick=close;
 overlay.querySelectorAll('[data-detail-action]').forEach(btn=>btn.onclick=()=>{if(operationsActive(s))operationsOpenForm(btn.dataset.detailAction,recordId);});
 overlay.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();close();}else if(e.key==='Tab'){const buttons=[...overlay.querySelectorAll('button')],first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
 overlay.querySelector('[data-close]').focus();
}
function operationsRenderDrafts(s=operationsSession()){
 const host=document.querySelector('[data-stock-drafts]');if(!host||!operationsActive(s))return;
 try{const drafts=SchoolHubDrafts.listStock(s.uid,s.school),esc=escapeHtml;host.innerHTML='<h4>Saved request drafts ('+drafts.length+')</h4><p class="hint">Saved on this device only. Open a draft to submit it after reconnecting. Each request has its own approval.</p>'+drafts.map(d=>{const item=operationsState?.items.find(x=>x.id===d.values.itemId);return '<div class="operations-draft-row"><div><strong>'+esc(item?.name||'Select an item')+'</strong><p>'+esc(d.values.quantityMilli||'No quantity')+' '+esc(item?.unit||'')+' · '+esc(d.values.purpose||'No purpose yet')+'</p></div><button type="button" class="btn-secondary" data-open-stock-draft="'+esc(d.id)+'">Open draft</button></div>';}).join('');host.querySelectorAll('[data-open-stock-draft]').forEach(button=>button.onclick=()=>operationsOpenForm('requestStock','',null,button.dataset.openStockDraft));}
 catch(error){host.textContent=error.message;}
}
function operationsOpenForm(action,recordId,paymentId,draftId){
 const s=operationsSession(),data=operationsState;if(!operationsActive(s)||!data)return;
 if(!s.head&&!['requestStock','cancelRequest'].includes(action))return;
 document.getElementById('operationsDialog')?.remove();const esc=escapeHtml,items=data.items.filter(x=>x.active);
 const field=(name,label,value='',type='text',options=null)=>({name,label,value,type,options});
 const itemOptions=items.map(x=>[x.id,x.name+' · '+operationsQty(x.quantityMilli)+' '+x.unit]);
 const item=data.items.find(x=>x.id===recordId),asset=data.assets.find(x=>x.id===recordId),liability=data.liabilities.find(x=>x.id===recordId),request=data.requests.find(x=>x.id===recordId);
 let fields=[],title='',record=item||asset||liability||request;
 if(action==='createItem'){title='Add stock item';fields=[field('code','Stock code','','auto-code'),field('name','Item name'),field('category','Category','','select',operationsCategoryOptions()),field('unit','Unit (pieces, boxes, kg…)','pieces'),field('quantityMilli','Opening stock','0','quantity'),field('minimumMilli','Low-stock threshold','0','quantity'),field('unitCost','Unit cost (GH₵)','0','money')];}
 if(action==='editItem'){title='Edit stock item';fields=[field('name','Item name',item.name),field('category','Category',item.category,'select',operationsCategoryOptions(item.category)),field('minimumMilli','Low-stock threshold',operationsQty(item.minimumMilli),'quantity'),field('unitCost','Unit cost (GH₵)',(item.unitCost/100).toFixed(2),'money'),field('active','Status',String(item.active),'select',[['true','Active'],['false','Archived (zero stock only)']])];}
 if(['receive','issue','adjust'].includes(action)){title={receive:'Receive stock',issue:'Issue stock',adjust:'Correct stock'}[action];fields=[field('id','Stock item',recordId||items[0]?.id||'','select',itemOptions),field('quantityMilli',action==='adjust'?'Quantity correction (+ or −)':'Quantity','','quantity'),field('reason',action==='receive'?'Supplier / delivery reference':action==='issue'?'Issued to / purpose':'Reason for correction')];}
 if(action==='createAsset'){title='Register asset';fields=[field('code','Asset tag'),field('name','Asset name'),field('category','Category','','select',operationsCategoryOptions()),field('cost','Acquisition cost (GH₵)','0','money'),field('value','Recorded value (GH₵)','0','money'),field('purchasedOn','Purchase date','','date'),field('location','Location'),field('custodian','Custodian')];}
 if(action==='editAsset'){title='Update asset';fields=[field('name','Asset name',asset.name),field('location','Location',asset.location),field('custodian','Custodian',asset.custodian),field('condition','Condition',asset.condition,'select',[['good','Good'],['fair','Fair'],['poor','Poor']]),field('status','Status',asset.status,'select',[['in_use','In use'],['repair','Under repair'],['disposed','Disposed']]),field('value','Recorded value (GH₵)',(asset.value/100).toFixed(2),'money'),field('reason','Reason for this update')];}
 if(['createLiability','editLiability'].includes(action)){title=action==='createLiability'?'Add supplier bill / debt':'Edit liability';fields=[field('creditor','Supplier / creditor',liability?.creditor||''),field('description','Description',liability?.description||''),field('amount','Amount owed (GH₵)',liability?String(liability.amount/100):'','money'),field('dueOn','Due date',liability?.dueOn||'','date'),field('reference','Invoice reference',liability?.reference||'')];}
 if(['settle','reverseSettlement'].includes(action)){title=action==='settle'?'Record liability payment':'Reverse recorded payment';fields=action==='settle'?[field('amount','Payment amount (GH₵)','','money'),field('reason','Payment method / reference')]:[field('reason','Reason for reversal')];}
 if(action==='requestStock'){title='Request stock';fields=[field('itemId','Stock item',recordId||items[0]?.id||'','select',itemOptions),field('quantityMilli','Quantity','','quantity'),field('purpose','Purpose')];}
 if(['approveRequest','rejectRequest','cancelRequest'].includes(action)){title={approveRequest:'Approve and issue stock',rejectRequest:'Reject stock request',cancelRequest:'Cancel my request'}[action];fields=[field('reason','Decision note')];}
 if(!title)return;if(fields.some(f=>f.options&&!f.options.length)){alert('Register an active stock item first.');return;}
 const optional=new Set(['category','location','custodian','reference','purchasedOn']);
 const overlay=document.createElement('div');overlay.id='operationsDialog';overlay.className='about-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label',title);
 overlay.innerHTML=`<div class="about-box operations-dialog"><h2>${esc(title)}</h2>${record?`<p>${esc(record.name||record.itemName||record.creditor)}</p>`:''}<form><div class="operations-form">${fields.map(f=>`<label>${esc(f.label)}${f.options?`<select name="${f.name}">${f.options.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(f.value)?'selected':''}>${esc(l)}</option>`).join('')}</select>`:`<input name="${f.name}" type="${f.type==='date'?'date':'text'}" ${['quantity','money'].includes(f.type)?'inputmode="decimal"':''} maxlength="500" value="${esc(f.value)}" ${f.type==='auto-code'?'readonly placeholder="Assigned when saved" aria-describedby="stock-code-hint"':optional.has(f.name)?'':'required'}>${f.type==='auto-code'?'<span id="stock-code-hint" class="hint">Generated automatically: SC-001, SC-002, and so on.</span>':''}`}</label>`).join('')}</div><p class="hint" data-status role="status"></p><div class="operations-toolbar"><button type="submit" class="btn-primary">Confirm save</button><button type="button" class="btn-secondary" data-close data-dismiss-ui>Close</button></div></form></div>`;
 document.body.append(overlay);const form=overlay.querySelector('form'),status=overlay.querySelector('[data-status]');overlay.querySelector('[data-close]').onclick=()=>overlay.remove();overlay.querySelector('input,select')?.focus();
 const requestDraft=action==='requestStock';let draft=null;if(requestDraft)form.querySelector('[type=submit]').textContent=(navigator.onLine===false||offlineAuthenticatedMode)?'Save draft':'Send request';
 if(requestDraft){
  try{const drafts=SchoolHubDrafts.listStock(s.uid,s.school);draft=draftId?drafts.find(x=>x.id===draftId):null;if(draftId&&!draft)throw Error('This draft is no longer saved. Reopen the draft list.');if(draft){for(const [key,value]of Object.entries(draft.values)){const control=form.elements.namedItem(key);if(control)control.value=value;}status.textContent='Draft restored. It has not been submitted.';}}
  catch(error){status.textContent=error.message;form.querySelector('[type=submit]').disabled=true;return;}
  const saveDraft=()=>{if(!operationsActive(s))throw Error('Reopen your active school account before saving.');draft=SchoolHubDrafts.saveStock(s.uid,s.school,draft?.id,Object.fromEntries(new FormData(form)));operationsRenderDrafts(s);status.textContent='Draft saved on this device. Connect and confirm to send your request.';};
  form.addEventListener('input',()=>{try{saveDraft();}catch(error){status.textContent='Draft could not be saved. Keep this form open. '+error.message;}});
  const button=document.createElement('button');button.type='button';button.className='btn-secondary';button.textContent='Save draft on this device';button.onclick=()=>{try{saveDraft();}catch(error){status.textContent=error.message;}};form.querySelector('.operations-toolbar').append(button);
  const next=document.createElement('button');next.type='button';next.className='btn-secondary';next.textContent='Save draft & add another';next.onclick=()=>{try{saveDraft();operationsOpenForm('requestStock');}catch(error){status.textContent=error.message;}};form.querySelector('.operations-toolbar').append(next);
  const discard=document.createElement('button');discard.type='button';discard.className='btn-secondary';discard.textContent='Discard this draft';discard.onclick=()=>{try{if(!operationsActive(s))return;if(draft)SchoolHubDrafts.removeStock(s.uid,s.school,draft.id);operationsRenderDrafts(s);overlay.remove();}catch(error){status.textContent=error.message;}};form.querySelector('.operations-toolbar').append(discard);
 }
 form.onsubmit=async e=>{
  e.preventDefault();if(!operationsActive(s))return;const submit=form.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;
  let slow,handedOff=false;
  try{
   if(requestDraft){draft=SchoolHubDrafts.saveStock(s.uid,s.school,draft?.id,Object.fromEntries(new FormData(form)));operationsRenderDrafts(s);if(navigator.onLine===false||offlineAuthenticatedMode){status.textContent='Draft saved on this device. Reconnect and verify before sending the request.';return;}}
   const values=Object.fromEntries(new FormData(form));if(action==='createItem')delete values.code;for(const f of fields){if(f.type==='money')values[f.name]=operationsMoney(values[f.name]);if(f.type==='quantity')values[f.name]=operationsQuantity(values[f.name],action==='adjust');}if(Object.hasOwn(values,'active'))values.active=values.active==='true';
   const id=values.id||(action==='requestStock'?'':recordId);if(id)values.id=id;const current=['receive','issue','adjust'].includes(action)?data.items.find(x=>x.id===id):record;if(current&&action!=='requestStock')values.revision=current.revision;if(paymentId)values.paymentId=paymentId;
   form.querySelectorAll('input,select,button').forEach(control=>{if(!control.hasAttribute('data-close'))control.disabled=true;});status.textContent='Saving and confirming…';slow=setTimeout(()=>{if(overlay.isConnected)status.textContent='Waiting for server confirmation. Keep the saved request; do not enter it again.';},25000);await operationsSubmit(action,values,requestDraft?draft.id:undefined);if(!operationsActive(s))return;if(requestDraft)SchoolHubDrafts.removeStock(s.uid,s.school,draft.id);overlay.remove();await renderSchoolOperations();
  }catch(error){let pendingRequest=false;try{pendingRequest=requestDraft&&draft&&operationsQueueRead(operationsQueueKey(s)).some(x=>x.request.requestId===draft.id);}catch(_){}if(pendingRequest){handedOff=true;SchoolHubDrafts.removeStock(s.uid,s.school,draft.id);status.textContent='Request saved pending server confirmation. Use the pending request to retry; do not submit a new copy.';operationsRenderDrafts(s);form.querySelectorAll('input,select,button').forEach(control=>{if(!control.hasAttribute('data-close'))control.disabled=true;});}else status.textContent=error.message;}finally{clearTimeout(slow);if(!handedOff)form.querySelectorAll('input,select,button').forEach(control=>control.disabled=false);}
 };
}
function operationsExport(data,tab){
 if(!isHeadTeacher()&&['assets','liabilities','history'].includes(tab))return;
 const source=tab==='stock'?data.items:tab==='assets'?data.assets:tab==='liabilities'?data.liabilities:tab==='history'?data.history:data.requests;
 const money=new Set(['unitCost','cost','value','amount','paid','balance']);
 const rows=source.map(row=>Object.fromEntries(Object.entries(tab==='liabilities'?{...row,balance:row.amount-row.paid}:row).map(([key,value])=>money.has(key)&&typeof value==='number'?[key+' (GH₵)',(value/100).toFixed(2)]:key.endsWith('Milli')&&typeof value==='number'?[key.slice(0,-5)+' (units)',String(value/1000)]:[key,value])));
 if(!rows.length){alert('No records to export.');return;}
 const headers=[...new Set(rows.flatMap(Object.keys))],cell=v=>{let text=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
 const csv=[headers.map(cell).join(','),...rows.map(row=>headers.map(k=>cell(row[k])).join(','))].join('\r\n'),url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='SchoolHub-'+tab+'-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
new MutationObserver(()=>{if(!sessionReady||currentStatus!=='active'||(operationsStateContext&&!operationsContextMatches(operationsStateContext))){document.getElementById('operationsDialog')?.remove();const host=document.getElementById('operationsWrap');if(host?.textContent)host.replaceChildren();operationsState=null;operationsStateContext=null;operationsLoad++;}}).observe(document.body,{attributes:true,attributeFilter:['class'],childList:true,subtree:true});
window.flushPendingSchoolOperationWrites=flushPendingSchoolOperationWrites;
// The restored page can become ready before this script finishes downloading.
document.addEventListener('DOMContentLoaded',()=>{
 const view=document.getElementById('view-operations');
 if(view&&!view.classList.contains('hidden')&&typeof sessionReady!=='undefined'&&sessionReady)renderSchoolOperations().catch(error=>console.warn('Operations restoration:',error));
},{once:true});

// Refresh this section only; background recovery retains its existing verification gates.
let operationsVisibleRefresh=null;
function operationsRefreshVisible(){
 const view=document.getElementById('view-operations'),s=operationsSession();
 if(document.visibilityState!=='visible'||!view||view.classList.contains('hidden')||!operationsActive(s)||navigator.onLine===false||offlineAuthenticatedMode||operationsBusy||document.getElementById('operationsDialog'))return Promise.resolve(false);
 if(operationsVisibleRefresh&&operationsContextMatches(operationsVisibleRefresh.session))return operationsVisibleRefresh.promise;
 const task={session:s};operationsVisibleRefresh=task;
 task.promise=renderSchoolOperations(true).then(()=>true).catch(error=>{console.warn('Operations refresh:',error);return false;}).finally(()=>{if(operationsVisibleRefresh===task)operationsVisibleRefresh=null;});return task.promise;
}
document.addEventListener('visibilitychange',operationsRefreshVisible);
window.addEventListener('focus',operationsRefreshVisible);
setInterval(operationsRefreshVisible,15000);
