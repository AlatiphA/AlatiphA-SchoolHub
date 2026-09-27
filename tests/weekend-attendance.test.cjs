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
