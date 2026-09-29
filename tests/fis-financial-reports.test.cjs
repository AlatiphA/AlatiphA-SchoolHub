const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const fees=fs.readFileSync('fees.js','utf8');
const css=fs.readFileSync('ui-polish.css','utf8');
function helpers(){const context={navigator:{},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},Map,Set,Promise,URL:{createObjectURL:()=>'',revokeObjectURL:()=>{}},Blob:function(){},document:{createElement:()=>({click(){}})},setTimeout(){}};vm.createContext(context);vm.runInContext(fees.split("window.addEventListener")[0],context);return context;}

test('FIS financial dashboard and report filters are present and read-only',()=>{
 for(const token of ['Financial dashboard & reports','feeDashboardKpis','feeReportYear','feeReportClass','feeReportCategory','feeReportStatus','feeReportDataMode','Export detailed CSV','Print / Save report PDF'])assert.ok(fees.includes(token),token);
 assert.ok(fees.includes('Filters never change fee records.'));
});

test('financial summary handles discounts, additions, arrears and collection totals',()=>{
 const c=helpers(),rows=[
  {studentId:'a',year:'2025/2026',term:'Term 3',baseAmount:10000,adjustment:-1000,paid:4000},
  {studentId:'b',year:'2026/2027',term:'Term 1',baseAmount:20000,adjustment:2000,paid:22000},
  {studentId:'c',year:'2026/2027',term:'Term 1',baseAmount:5000,adjustment:0,paid:0,cancelled:true}
 ];
 const s=c.feeFinancialSummary(rows,'2026/2027','Term 1');
 assert.equal(s.due,31000);assert.equal(s.paid,26000);assert.equal(s.balance,5000);assert.equal(s.discounts,1000);assert.equal(s.additions,2000);assert.equal(s.arrears,5000);assert.equal(s.pupils.size,1);
});

test('report filters separate production, test, class, category and balance status',()=>{
 const c=helpers(),rows=[
  {id:'1',studentId:'a',classId:'c1',categoryId:'pta',year:'2026/2027',term:'Term 1',baseAmount:10000,paid:0},
  {id:'2',studentId:'b',classId:'c2',categoryId:'ict',year:'2026/2027',term:'Term 1',baseAmount:10000,paid:10000,isTestData:true},
  {id:'3',studentId:'c',classId:'c1',categoryId:'pta',year:'2025/2026',term:'Term 3',baseAmount:10000,paid:0,cancelled:true}
 ];
 assert.deepEqual(rows.filter(x=>c.feeReportFilterCharge(x,{year:'2026/2027',classId:'c1',categoryId:'pta',status:'outstanding',dataMode:'production'})).map(x=>x.id),['1']);
 assert.deepEqual(rows.filter(x=>c.feeReportFilterCharge(x,{status:'settled',dataMode:'test'})).map(x=>x.id),['2']);
 assert.deepEqual(rows.filter(x=>c.feeReportFilterCharge(x,{status:'cancelled',dataMode:'all'})).map(x=>x.id),['3']);
});

test('payment method analytics count only allocations matching the filtered charges and ignore voids',()=>{
 const c=helpers(),map=new Map([['a',{id:'a'}],['b',{id:'b'}]]),ids=new Set(['a']);
 const rows=c.feePaymentMethodSummary([{id:'p1',method:'Cash',allocations:[{chargeId:'a',amount:5000},{chargeId:'b',amount:2000}]},{id:'p2',method:'Cash',allocations:[{chargeId:'a',amount:3000}],voided:true},{id:'p3',method:'Mobile Money',allocations:[{chargeId:'a',amount:1000}]}],map,ids);
 assert.deepEqual(JSON.parse(JSON.stringify(rows)),[{method:'Cash',amount:5000,receiptCount:1},{method:'Mobile Money',amount:1000,receiptCount:1}]);
});

test('pupil statements include charge, payment, CSV and print controls with responsive styling',()=>{
 for(const token of ['Pupil statements','feeStatementPupil','feeStatementPreview','Export statement CSV','Print / Save statement PDF','feeStatementHtml','feePrintDialog'])assert.ok(fees.includes(token),token);
 for(const token of ['.fee-dashboard-kpis','.fee-report-grid','.fee-statement-table','#feePrintDialog .fee-print-box','body:has(#feePrintDialog)'])assert.ok(css.includes(token),token);
});

test('CSV export protects spreadsheet formulas without converting numeric amounts to text',()=>{
 const c=helpers();
 assert.equal(c.feeCsvCell('=HYPERLINK("bad")'), `"'=HYPERLINK(""bad"")"`);
 assert.equal(c.feeCsvCell('-10.00'),'-10.00');
 assert.equal(c.feeCsvCell('100.00'),'100.00');
});
