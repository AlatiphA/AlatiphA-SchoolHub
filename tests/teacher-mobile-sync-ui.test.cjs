const fs=require('fs');
const assert=require('assert');

const app=fs.readFileSync('app-4.js','utf8');
const index=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('style-3.css','utf8');
const firestore=fs.readFileSync('firestore.rules','utf8');
const storage=fs.readFileSync('storage.rules','utf8');
const sw=fs.readFileSync('sw.js','utf8');

assert(app.includes("setupLink.textContent = activeTeacher ? 'Home' : 'Go to Setup'"));
assert(app.includes("showView(isTeacher() ? 'home' : 'setup')"));
assert(app.includes("billingLink.classList.toggle('hidden', !isHeadTeacher())"));

assert(css.includes('z-index:9;'));
assert(css.includes('background:var(--surface);'));
assert(css.includes('#schoolHubFloatingPill button.active{'));
assert(css.includes('background:var(--gold);'));
assert(css.includes('color:var(--ink);'));

assert(app.includes("cloudHydrationStatusError = ''"));
assert(app.includes("statusButton.textContent = 'Still syncing'"));
assert(app.includes("hydrationFailed ? 'Sync issue'"));

assert(app.includes("imageAssetRef('student',id).get()"));
assert(app.includes("getAccessibleStudents({includeInactive:true})"));
assert(firestore.includes('function hasCurrentStudent(schoolId, studentId)'));
assert(firestore.includes('hasCurrentStudent(schoolId, resource.data.recordId)'));
assert(storage.includes('function isCurrentAssignedStudent(schoolId, studentId)'));
assert(storage.includes('isCurrentAssignedStudent(schoolId, fileName)'));

assert(index.includes('Accessible cloud images'));
assert(index.includes('Cached accessible images'));
assert(sw.includes('schoolhub-cache-v40-theme-system-fix-6'));

console.log('teacher mobile/profile/sync regression: PASS');
