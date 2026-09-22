const fs = require('fs');
const assert = require('assert');

for (const file of ['style-3.css', 'public/style-3.css']) {
  const css = fs.readFileSync(file, 'utf8');
  assert(css.includes('#view-grades table.grades-table{min-width:1380px;}'));
  assert(css.includes('width:66px;'));
  assert(css.includes('min-width:66px;'));
  assert(css.includes('box-sizing:border-box;'));
}
console.log('desktop grade input visibility regression: PASS');
