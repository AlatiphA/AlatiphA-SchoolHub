const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const css=fs.readFileSync(path.join(root,'weekly-supervision.css'),'utf8');
const publicCss=fs.readFileSync(path.join(root,'public/weekly-supervision.css'),'utf8');
const observations=fs.readFileSync(path.join(root,'lesson-observations.js'),'utf8');

test('observation counts use a full-width centered count column on desktop and mobile',()=>{
  assert.match(observations,/const node=\(tag,text,cls\)=>\{[^}]*if\(cls\)n\.className=cls/,
    'observation renderer must apply the optional CSS class passed to node()');
  assert.match(observations,/supervision-summary-table observation-count-table/);
  assert.match(observations,/node\('div',null,'supervision-table-scroll supervision-summary-scroll'\)/);
  assert.match(observations,/node\('table',null,'supervision-table supervision-summary-table observation-count-table'\)/);
  const layout=css.match(/#supervisionWrap \.lesson-observations \.observation-count-table\{([^}]+)\}/);
  assert.ok(layout,'observation table needs a dedicated full-width layout');
  assert.match(layout[1],/display:block/);
  assert.match(layout[1],/width:100%!important/);
  assert.match(layout[1],/min-width:0!important/);
  const grid=css.match(/#supervisionWrap \.lesson-observations \.observation-count-table tr\{([^}]+)\}/);
  assert.ok(grid,'header, teacher, and total rows need explicit shared columns');
  assert.match(grid[1],/grid-template-columns:minmax\(0,2fr\) minmax\(112px,1fr\)/);
  assert.match(css,/\.observation-count-table :is\(th,td\):nth-child\(2\)\{[^}]*justify-content:center;[^}]*text-align:center!important/s);
  assert.match(css,/\.observation-count-table thead th\{[^}]*position:sticky!important;[^}]*top:0/s,
    'observation headings must stay visible while the summary scrolls');
  assert.match(css,/\.observation-count-table thead th:first-child\{[^}]*justify-content:center;[^}]*text-align:center!important/s,
    'Teacher heading must be centered while teacher names remain left aligned');
  assert.equal(publicCss,css,'the deployed stylesheet must match the source stylesheet');
});
