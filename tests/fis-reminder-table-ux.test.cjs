const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const fees=fs.readFileSync('fees.js','utf8');
const css=fs.readFileSync('ui-polish.css','utf8');
const sw=fs.readFileSync('sw.js','utf8');

test('Reminder Generator gives visible action feedback without changing send semantics',()=>{
  for(const token of [
    "feeActionToast('Reminder copied to clipboard.')",
    "feeTemporaryButtonLabel(button,'Copied')",
    "feeActionToast('Opening WhatsApp…','info')",
    "Reminder print preview opened.",
    "WhatsApp could not be opened. Check your browser pop-up settings."
  ]) assert.ok(fees.includes(token), token);
  assert.ok(fees.includes("window.open(`https://wa.me/${digits}?text=${encodeURIComponent(feeReminderText(row,settings,reminderOptions()))}`,'_blank','noopener')"));
});

test('all Fees and Receipts table wrappers scroll horizontally and pin their row label column',()=>{
  for(const token of [
    '#app #view-fees .table-scroll{',
    'overflow-x:auto',
    '#app #view-fees .table-scroll > table :is(th,td):first-child{',
    'position:sticky; left:0',
    '#app #view-fees .table-scroll > table thead th{',
    'text-align:center!important'
  ]) assert.ok(css.includes(token), token);
});

test('arrears table pins the pupil name beside its selection checkbox',()=>{
  assert.ok(css.includes('#app #view-fees .fee-arrears-table :is(th,td):nth-child(2){'));
  assert.ok(css.includes('left:58px'));
  assert.ok(css.includes('#app #view-fees .fee-arrears-table tbody td:nth-child(2){text-align:left!important;}'));
});

test('receipt allocation table participates in mobile horizontal scrolling',()=>{
  assert.ok(fees.includes('table-scroll fee-dialog-table-scroll'));
  assert.ok(css.includes('#feeReceiptDialog .fee-dialog-table-scroll'));
});

test('service worker cache is bumped for reminder feedback and table UX delivery',()=>{
  assert.match(sw,/schoolhub-cache-v40-fis-notification-audit-1/);
});
