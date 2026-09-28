const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('app-4.js','utf8');
function fn(name){const start=src.indexOf('function '+name+'(');const end=src.indexOf('\nfunction ',start+1);return src.slice(start,end);}
function fixture(){
 const records=['2026-09-25','2026-09-26','2026-09-27','2026-09-28'].map((date,i)=>({date,record:{entries:{p:['P','A','L','L'][i],t:['P','E','O','A'][i]}}}));
 const ctx={parseDateOnly:s=>new Date(s+'T12:00:00'),calendarRecord:()=>null,KEYS:{staff:'staff'},DB:{get:()=>[{id:'t'}]},isTeacherStaffRecord:()=>true,getAccessibleStudents:()=>[{id:'p',classId:'c'}],attendanceRecordsForTerm:()=>records,teacherAttendanceRecordsForTerm:()=>records};
 vm.createContext(ctx);for(const name of ['isWeekdayDate','attendanceDayType','attendanceSummary','teacherAttendanceSummary','reportPupilAttendance'])vm.runInContext(fn(name),ctx);return ctx;
}
test('weekends remain closed even when a calendar record says open',()=>{
 const c=fixture();c.calendarRecord=()=>({type:'open'});
 for(const date of ['2026-09-26','2026-09-27'])assert.equal(c.attendanceDayType('T','Y',date),'weekend');
 assert.equal(c.attendanceDayType('T','Y','2026-09-28'),'open');
});
test('existing weekend marks do not count for pupils, teachers or report cards',()=>{
 const c=fixture(),p=c.attendanceSummary('c','T','Y').summary.p,t=c.teacherAttendanceSummary('T','Y').summary.t;
 assert.equal(p.total,2);assert.equal(p.absent,0);assert.equal(p.recorded,2);
 assert.equal(t.total,1);assert.equal(t.absent,1);assert.equal(t.excused,0);assert.equal(t.leave,0);assert.equal(t.recorded,2);
 assert.equal(c.reportPupilAttendance({id:'p',classId:'c'},{currentTerm:'T',currentYear:'Y'},{attendance:99}),2);
});

test('school-wide strikes suppress saved marks without erasing them',()=>{
 const c=fixture();c.calendarRecord=(t,y,date)=>date==='2026-09-25'?{type:'strike'}:null;
 assert.equal(c.attendanceDayType('T','Y','2026-09-25'),'strike');
 assert.equal(c.attendanceSummary('c','T','Y').summary.p.total,1);assert.equal(c.teacherAttendanceSummary('T','Y').summary.t.total,0);
 c.calendarRecord=()=>null;assert.equal(c.attendanceSummary('c','T','Y').summary.p.total,2);assert.equal(c.teacherAttendanceSummary('T','Y').summary.t.total,1);
});
test('individual strike is separate from absence and ratio policy is explicit',()=>{
 const c=fixture();c.teacherAttendanceRecordsForTerm=()=>[{date:'2026-09-25',record:{entries:{t:'S'}}}];
 const summary=c.teacherAttendanceSummary('T','Y').summary.t;assert.equal(summary.strike,1);assert.equal(summary.absent,0);assert.equal(summary.recorded,1);
 vm.runInContext(fn('attendanceRatio'),c);let policy='';c.KEYS.settings='settings';c.DB.get=()=>({teacherStrikeRatioPolicy:policy});
 const sm={...summary,total:1};assert.equal(c.attendanceRatio(sm,2,true),null);policy='include';assert.equal(c.attendanceRatio(sm,2,true),50);policy='exclude';assert.equal(c.attendanceRatio(sm,2,true),100);
});
test('all open-date calculations exclude a weekday school strike',()=>{
 const c=fixture();Object.assign(c,{getTermDates:()=>({start:'2026-09-21',end:'2026-09-25'}),schoolCalendarRecordsForTerm:()=>[{date:'2026-09-23',record:{type:'strike'}}],addDaysDateOnly:(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n),dateOnlyString:d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')});
 vm.runInContext(fn('calculateTimesOpen'),c);assert.equal(c.calculateTimesOpen('T','Y','2026-09-25'),4);
});
