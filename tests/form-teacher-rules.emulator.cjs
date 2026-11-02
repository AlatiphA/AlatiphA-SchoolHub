const {test,before,after}=require('node:test'),{readFileSync}=require('node:fs');
const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');
const {doc,setDoc,getDoc,collection,getDocs,updateDoc}=require('firebase/firestore');
let env;
before(async()=>{env=await initializeTestEnvironment({projectId:'demo-schoolhub-audit',firestore:{rules:readFileSync('firestore.rules','utf8')}});await env.withSecurityRulesDisabled(async ctx=>{for(const [path,data]of Object.entries({
 'users/form':{role:'teacher',status:'active',schoolId:'s',assignedClassIds:['c1'],assignedSubjectIds:['math'],formClassIds:['c1']},
 'users/subject':{role:'teacher',status:'active',schoolId:'s',assignedClassIds:['c1'],assignedSubjectIds:['math']},
 'users/disabled':{role:'teacher',status:'disabled',schoolId:'s',assignedClassIds:['c1'],formClassIds:['c1']},
 'schools/s':{ownerUid:'head'},'schools/s/subjects/math':{name:'Math'},'schools/s/subjects/english':{name:'English'},'schools/s/grades/c1':{classId:'c1',entries:{p:{english:{e:70}}}},'schools/s/grades/c2':{classId:'c2',entries:{}}
 }))await setDoc(doc(ctx.firestore(),path),data);});});
after(async()=>env?.cleanup());
test('form teacher can read the complete subject catalog but not another class or write scores directly',async()=>{const db=env.authenticatedContext('form').firestore();await assertSucceeds(getDocs(collection(db,'schools/s/subjects')));await assertSucceeds(getDoc(doc(db,'schools/s/grades/c1')));await assertFails(getDoc(doc(db,'schools/s/grades/c2')));await assertFails(setDoc(doc(db,'schools/s/grades/c1'),{classId:'c1',entries:{}}));});
test('subject teachers cannot widen their own report permissions or read other subjects catalog',async()=>{const db=env.authenticatedContext('subject').firestore();await assertSucceeds(getDoc(doc(db,'schools/s/subjects/math')));await assertFails(getDoc(doc(db,'schools/s/subjects/english')));await assertFails(updateDoc(doc(db,'users/subject'),{formClassIds:['c1']}));});
test('disabled form teacher cannot read report catalog',async()=>{await assertFails(getDocs(collection(env.authenticatedContext('disabled').firestore(),'schools/s/subjects')));});
