const fs = require('fs');
const assert = require('assert');

for (const file of ['app-4.js', 'public/app-4.js']) {
  const js = fs.readFileSync(file, 'utf8');

  assert(js.includes('<button class="save-btn save-class" data-id="${c.id}">Update</button>'));
  assert(js.includes('<button class="save-btn save-student" data-id="${st.id}">Update</button>'));
  assert(js.includes('<button class="save-btn save-subject" data-id="${sub.id}">Update</button>'));
  assert(js.includes('<button class="save-btn save-staff" data-id="${st.id}">Update</button>'));
  assert(js.includes("const actionLabel = m.status === 'pending' ? 'Approve & Save' : 'Update Teacher';"));

  assert(!js.includes('<button class="save-btn save-class" data-id="${c.id}">Save</button>'));
  assert(!js.includes('<button class="save-btn save-student" data-id="${st.id}">Save</button>'));
  assert(!js.includes('<button class="save-btn save-subject" data-id="${sub.id}">Save</button>'));
  assert(!js.includes('<button class="save-btn save-staff" data-id="${st.id}">Save</button>'));
}
console.log('edit/update labels regression: PASS');
