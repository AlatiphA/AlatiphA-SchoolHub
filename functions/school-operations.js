'use strict';
const crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,function(key,v){return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;});
function register({onCall,HttpsError,db,admin}){
 const fail=(code,message)=>{throw new HttpsError(code,message);};
 const call=fn=>onCall({region:'us-central1',invoker:'public',timeoutSeconds:90},fn);
 const text=(v,label,max=160,optional=false)=>{if(optional&&(v==null||v===''))return '';if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail('invalid-argument',label+' is required (maximum '+max+' characters).');return v.trim();};
 const number=(v,label,max=1000000000,signed=false)=>{if(!Number.isSafeInteger(v)||Math.abs(v)>max||(!signed&&v<0))fail('invalid-argument','Invalid '+label+'.');return v;};
 const positive=(v,label)=>{number(v,label);if(v<=0)fail('invalid-argument',label+' must be greater than zero.');return v;};
 const id=v=>{text(v,'Record ID',120);if(!/^[A-Za-z0-9_-]{8,120}$/.test(v))fail('invalid-argument','Invalid record ID.');return v;};
 const date=(v,optional=false)=>{if(optional&&!v)return '';text(v,'Date',10);const parsed=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==v)fail('invalid-argument','Enter a valid date.');return v;};
 const read=async(tx,ref)=>{const snap=await tx.get(ref);if(!snap.exists)fail('not-found','This record no longer exists. Refresh the list.');return snap.data();};
 const revision=(record,d)=>{if(!Number.isSafeInteger(d.revision)||d.revision!==record.revision)fail('aborted','This record changed on another device. Refresh and review before saving.');};
 async function access(tx,r){
  if(!r.auth)fail('unauthenticated','Sign in first.');
  if(r.data?.expectedUid!==r.auth.uid)fail('failed-precondition','Your sign-in changed. Reopen the correct account before continuing.');
  const u=(await tx.get(db.collection('users').doc(r.auth.uid))).data();
  if(!u||u.status!=='active'||!u.schoolId||!['headteacher','teacher'].includes(u.role))fail('permission-denied','An active school account is required.');
  if(r.data?.expectedSchoolId!==u.schoolId)fail('failed-precondition','Your school changed. Reopen the correct school before continuing.');
  return {user:u,school:db.collection('schools').doc(u.schoolId)};
 }
 const fields=['opItems','opAssets','opLiabilities','opRequests'];
 const getSchoolOperations=call(r=>db.runTransaction(async tx=>{
  const {user,school}=await access(tx,r),head=user.role==='headteacher';
  const queries=head?fields.map(f=>school.collection(f)):[school.collection('opItems'),school.collection('opRequests').where('createdBy','==',r.auth.uid)];
  const snapshots=await Promise.all(queries.map(q=>tx.get(q))),rows=s=>s.docs.map(doc=>({id:doc.id,...doc.data()}));
  if(!head){
   const requestFields=['id','itemId','itemName','unit','quantityMilli','purpose','status','requestedBy','createdBy','createdAt','revision','decisionNote','resolvedAt'];
   return {role:'teacher',items:rows(snapshots[0]).filter(x=>x.active).map(x=>({id:x.id,code:x.code,name:x.name,category:x.category,unit:x.unit,quantityMilli:x.quantityMilli,active:true})),requests:rows(snapshots[1]).map(x=>Object.fromEntries(requestFields.filter(k=>Object.hasOwn(x,k)).map(k=>[k,x[k]]))),assets:[],liabilities:[],history:[]};
  }
  const history=await tx.get(school.collection('opHistory').orderBy('createdAt','desc').limit(150));
  return {role:'headteacher',items:rows(snapshots[0]),assets:rows(snapshots[1]),liabilities:rows(snapshots[2]),requests:rows(snapshots[3]),history:rows(history)};
 }));
 const updateSchoolOperations=call(r=>db.runTransaction(async tx=>{
  const {user,school}=await access(tx,r),d=r.data||{},action=text(d.action,'Action',40),requestId=id(d.requestId),uid=r.auth.uid,head=user.role==='headteacher';
  if(!head&&!['requestStock','cancelRequest'].includes(action))fail('permission-denied','Only the Head Teacher can manage school property or payments.');
  if(Buffer.byteLength(canonical(d))>16000)fail('invalid-argument','Save is too large.');
  const receipt=school.collection('opReceipts').doc(hash(uid+'|'+requestId)),fingerprint=hash(canonical(d)),prior=await tx.get(receipt);
  if(prior.exists){if(prior.data().fingerprint!==fingerprint)fail('failed-precondition','This retry does not match its original save.');return prior.data().result;}
  const now=new Date().toISOString(),schoolData=await read(tx,school),recordId=d.id?id(d.id):requestId;
  let result={id:recordId},changed=[],notification=null,summary='',entityName='';
  const save=(ref,value)=>changed.push([ref,value]);
  const recordRef=kind=>school.collection(kind).doc(recordId);
  const next=(old,changes)=>({...old,...changes,revision:old.revision+1,updatedAt:now,updatedBy:uid});
  const base=()=>({createdAt:now,createdBy:uid,updatedAt:now,updatedBy:uid,revision:0});
  if(action==='createItem'||action==='createAsset'){
   const asset=action==='createAsset',ref=recordRef(asset?'opAssets':'opItems');
   let code,counterRef,nextNumber;
   if(asset)code=text(d.code,'Asset tag',60).toUpperCase();
   else{
    // A shared school counter serializes automatic and legacy manual additions.
    counterRef=school.collection('opCounters').doc('stockCodes');
    const counter=await tx.get(counterRef);
    const suffix=value=>{const match=/^SC-(\d+)$/i.exec(String(value||''));if(!match)return 0;const n=Number(match[1]);if(!Number.isSafeInteger(n)||n>=Number.MAX_SAFE_INTEGER)fail('failed-precondition','Stock code sequence needs administrator review.');return n;};
    if(counter.exists){nextNumber=counter.data().nextNumber;if(!Number.isSafeInteger(nextNumber)||nextNumber<1||nextNumber>=Number.MAX_SAFE_INTEGER)fail('failed-precondition','Stock code sequence needs administrator review.');}
    else{
     const [items,codes]=await Promise.all([tx.get(school.collection('opItems')),tx.get(school.collection('opCodes'))]);
     nextNumber=1;
     for(const doc of items.docs)nextNumber=Math.max(nextNumber,suffix(doc.data().code)+1);
     for(const doc of codes.docs)if(doc.data().kind!=='asset'){
      // Legacy locks have no kind: include them conservatively, preserving reservations.
      nextNumber=Math.max(nextNumber,suffix(doc.data().code)+1);
     }
    }
    if(d.code==null||d.code===''){
     let available=false;
     for(let attempt=0;attempt<100;attempt++){
      if(nextNumber>=Number.MAX_SAFE_INTEGER)fail('failed-precondition','Stock code sequence is exhausted.');
      code='SC-'+String(nextNumber++).padStart(3,'0');
      if(!(await tx.get(school.collection('opCodes').doc(hash('item:'+code)))).exists){available=true;break;}
     }
     if(!available)fail('failed-precondition','Stock code sequence needs administrator review.');
    }else{code=text(d.code,'Stock code',60).toUpperCase();nextNumber=Math.max(nextNumber,suffix(code)+1);}
    save(counterRef,{nextNumber,updatedAt:now});result.code=code;
   }
   const lock=school.collection('opCodes').doc(hash((asset?'asset:':'item:')+code));
   if((await tx.get(ref)).exists||(await tx.get(lock)).exists)fail('already-exists','That stock code or asset tag is already registered.');
   entityName=text(d.name,'Name');
   const common={...base(),code,name:entityName,category:text(d.category,'Category',100,true)};
   if(asset){const cost=number(d.cost,'Acquisition cost'),value=number(d.value,'Recorded value');if(value>cost)fail('invalid-argument','Recorded value cannot exceed acquisition cost.');save(ref,{...common,cost,value,purchasedOn:date(d.purchasedOn,true),location:text(d.location,'Location',160,true),custodian:text(d.custodian,'Custodian',160,true),condition:'good',status:'in_use'});}
   else save(ref,{...common,unit:text(d.unit,'Unit',30),quantityMilli:number(d.quantityMilli,'Opening stock'),minimumMilli:number(d.minimumMilli,'Minimum stock'),unitCost:number(d.unitCost,'Unit cost'),active:true});
   save(lock,{id:recordId,code,kind:asset?'asset':'item'});summary=asset?'Asset registered':'Stock item registered';
  }else if(action==='editItem'){
   const ref=recordRef('opItems'),old=await read(tx,ref);revision(old,d);entityName=old.name;
   const active=d.active;if(typeof active!=='boolean')fail('invalid-argument','Choose active or archived.');
   if(!active){if(old.quantityMilli)fail('failed-precondition','Issue or correct the remaining stock before archiving.');const pending=await tx.get(school.collection('opRequests').where('itemId','==',recordId));if(pending.docs.some(doc=>doc.data().status==='pending'))fail('failed-precondition','Resolve pending requests before archiving.');}
   save(ref,next(old,{name:text(d.name,'Name'),category:text(d.category,'Category',100,true),minimumMilli:number(d.minimumMilli,'Minimum stock'),unitCost:number(d.unitCost,'Unit cost'),active}));summary='Stock item updated';
  }else if(['receive','issue','adjust'].includes(action)){
   const ref=recordRef('opItems'),old=await read(tx,ref);revision(old,d);if(!old.active)fail('failed-precondition','This item is archived.');
   const quantity=action==='adjust'?number(d.quantityMilli,'Adjustment',1000000000,true):positive(d.quantityMilli,'Quantity');if(!quantity)fail('invalid-argument','Enter a non-zero adjustment.');
   const delta=action==='issue'?-quantity:quantity,newQuantity=old.quantityMilli+delta;if(newQuantity<0)fail('failed-precondition','Not enough stock available.');number(newQuantity,'Resulting stock');
   const reason=text(d.reason,action==='receive'?'Supplier / reference':action==='issue'?'Issued to / purpose':'Correction reason',500);
   save(ref,next(old,{quantityMilli:newQuantity}));result={id:recordId,quantityMilli:newQuantity};summary=action==='receive'?'Stock received':action==='issue'?'Stock issued':'Stock corrected';entityName=old.name;
   result.movement={quantityMilli:delta,reason};
  }else if(action==='editAsset'){
   const ref=recordRef('opAssets'),old=await read(tx,ref);revision(old,d);const status=text(d.status,'Status',30),condition=text(d.condition,'Condition',30),value=number(d.value,'Recorded value');
   if(!['in_use','repair','disposed'].includes(status)||!['good','fair','poor'].includes(condition)||value>old.cost||(status==='disposed'&&value!==0))fail('invalid-argument','Choose a valid condition, status and value. Disposed assets must have zero recorded value.');
   const reason=text(d.reason,'Update reason',500);save(ref,next(old,{name:text(d.name,'Name'),location:text(d.location,'Location',160,true),custodian:text(d.custodian,'Custodian',160,true),condition,status,value}));entityName=old.name;summary='Asset updated';result.reason=reason;
  }else if(action==='createLiability'){
   const ref=recordRef('opLiabilities');if((await tx.get(ref)).exists)fail('already-exists','This liability already exists.');
   entityName=text(d.creditor,'Supplier / creditor');save(ref,{...base(),creditor:entityName,description:text(d.description,'Description',500),amount:positive(d.amount,'Amount owed'),paid:0,dueOn:date(d.dueOn),reference:text(d.reference,'Invoice reference',160,true)});summary='Liability registered';
  }else if(action==='editLiability'){
   const ref=recordRef('opLiabilities'),old=await read(tx,ref);revision(old,d);const amount=positive(d.amount,'Amount owed');if(amount<old.paid)fail('failed-precondition','Amount owed cannot be less than payments already recorded.');
   save(ref,next(old,{creditor:text(d.creditor,'Supplier / creditor'),description:text(d.description,'Description',500),amount,dueOn:date(d.dueOn),reference:text(d.reference,'Invoice reference',160,true)}));summary='Liability updated';entityName=old.creditor;
  }else if(action==='settle'){
   const ref=recordRef('opLiabilities'),old=await read(tx,ref);revision(old,d);const amount=positive(d.amount,'Payment');if(amount>old.amount-old.paid)fail('failed-precondition','Payment exceeds the outstanding balance.');
   const reason=text(d.reason,'Payment reference / method',500),paymentId=hash(uid+'|'+requestId);save(ref,next(old,{paid:old.paid+amount}));save(school.collection('opSettlements').doc(paymentId),{liabilityId:recordId,amount,reason,voided:false,createdAt:now,createdBy:uid});result={id:recordId,paymentId,amount,reason};summary='Liability payment recorded';entityName=old.creditor;
  }else if(action==='reverseSettlement'){
   const paymentRef=school.collection('opSettlements').doc(id(d.paymentId)),payment=await read(tx,paymentRef);if(payment.voided)fail('failed-precondition','This payment has already been reversed.');
   const ref=school.collection('opLiabilities').doc(payment.liabilityId),old=await read(tx,ref);revision(old,d);if(old.paid<payment.amount)fail('failed-precondition','Payment history needs review.');
   const reason=text(d.reason,'Reversal reason',500);save(ref,next(old,{paid:old.paid-payment.amount}));save(paymentRef,{...payment,voided:true,voidedAt:now,voidedBy:uid,voidReason:reason});result={id:payment.liabilityId,paymentId:d.paymentId,amount:-payment.amount,reason};summary='Liability payment reversed';entityName=old.creditor;
  }else if(action==='requestStock'){
   const itemId=id(d.itemId),item=await read(tx,school.collection('opItems').doc(itemId));if(!item.active)fail('failed-precondition','This stock item is archived.');
   const ref=recordRef('opRequests');if((await tx.get(ref)).exists)fail('already-exists','Request already exists.');
   const quantityMilli=positive(d.quantityMilli,'Quantity'),purpose=text(d.purpose,'Purpose',500);entityName=item.name;
   save(ref,{...base(),itemId,itemName:item.name,unit:item.unit,quantityMilli,purpose,status:'pending',requestedBy:user.displayName||user.email||uid});summary='Stock requested';
   if(schoolData.ownerUid)notification={uid:schoolData.ownerUid,title:'Stock request',body:(user.displayName||'A teacher')+' requested '+item.name+'.'};
  }else if(['approveRequest','rejectRequest','cancelRequest'].includes(action)){
   const ref=recordRef('opRequests'),old=await read(tx,ref);revision(old,d);if(old.status!=='pending')fail('failed-precondition','This request has already been resolved.');
   if(action==='cancelRequest'&&old.createdBy!==uid)fail('permission-denied','You can cancel only your own request.');
   const reason=text(d.reason,'Decision note',500);entityName=old.itemName;
   if(action==='approveRequest'){
    const member=(await tx.get(db.collection('users').doc(old.createdBy))).data();if(!member||member.status!=='active'||member.schoolId!==user.schoolId)fail('failed-precondition','The requester is no longer active in this school. Reject this request instead.');
    const itemRef=school.collection('opItems').doc(old.itemId),item=await read(tx,itemRef);if(!item.active||item.quantityMilli<old.quantityMilli)fail('failed-precondition','Not enough active stock to fulfil this request.');
    save(itemRef,next(item,{quantityMilli:item.quantityMilli-old.quantityMilli}));result.movement={quantityMilli:-old.quantityMilli,reason};
   }
   const status=action==='approveRequest'?'approved':action==='rejectRequest'?'rejected':'cancelled';save(ref,next(old,{status,decisionNote:reason,resolvedAt:now,resolvedBy:uid}));summary='Stock request '+status;
   if(old.createdBy!==uid)notification={uid:old.createdBy,title:'Stock request '+status,body:old.itemName+': '+reason};
  }else fail('invalid-argument','Unknown operations action.');
  if(notification){
   const target=(await tx.get(db.collection('users').doc(notification.uid))).data();
   if(!target||target.status!=='active'||target.schoolId!==user.schoolId||(action==='requestStock'&&target.role!=='headteacher'))notification=null;
  }
  // All reads precede all writes; receipt, balances, decisions and history commit together.
  for(const [ref,value]of changed)tx.set(ref,value);
  if(head)tx.set(school.collection('opHistory').doc(hash(uid+'|'+requestId)),{action,summary,entityName,entityId:result.id,actorUid:uid,createdAt:now,...(result.movement||{}),...(result.reason?{reason:result.reason}:{}),...(result.amount!==undefined?{amount:result.amount}:{}),...(result.paymentId?{paymentId:result.paymentId}:{})});
  if(notification)tx.set(db.collection('users').doc(notification.uid).collection('notifications').doc('operations_'+hash(uid+'|'+requestId)),{title:notification.title,body:notification.body,type:'operations',action:'operations',schoolId:user.schoolId,actorUid:uid,read:false,createdAt:admin.firestore.FieldValue.serverTimestamp()});
  tx.set(receipt,{fingerprint,result,createdAt:now,createdBy:uid});return result;
 }));
 return {getSchoolOperations,updateSchoolOperations};
}
module.exports={register,canonical};
