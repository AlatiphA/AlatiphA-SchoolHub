const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const app=fs.readFileSync('app-4.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const hosted=fs.readFileSync('public/index.html','utf8');
const css=fs.readFileSync('style-3.css','utf8');
const hostedCss=fs.readFileSync('public/style-3.css','utf8');
const rules=fs.readFileSync('firestore.rules','utf8');
const sw=fs.readFileSync('sw.js','utf8');
const functionsIndex=fs.readFileSync('functions/index.js','utf8');
const notificationFunctions=fs.readFileSync('functions/notifications.js','utf8');
const faq=fs.readFileSync('faq.html','utf8');
const hostedFaq=fs.readFileSync('public/faq.html','utf8');

test('notification center, bell and pending approval controls ship in both hosting mirrors',()=>{
  for(const token of ['id="notificationBtn"','id="notificationBadge"','id="notificationCenterDialog"','id="notificationMarkAllReadBtn"','id="notificationBrowserToggleBtn"','id="notificationAnnouncementBody"','id="pendingNotificationsBtn"','id="pendingCheckStatusBtn"']){
    assert.ok(html.includes(token),token);
  }
  assert.equal(hosted,html);
  assert.equal(hostedCss,css);
});

test('explicit sign-in notifications distinguish real login actions from restored sessions',()=>{
  assert.ok(app.includes("recordExplicitSchoolSignIn('password')"));
  assert.ok(app.includes("recordExplicitSchoolSignIn('google')"));
  assert.ok(app.includes("httpsCallable('recordSchoolSignIn')"));
  assert.ok(!app.includes("recordExplicitSchoolSignIn('restore')"));
  assert.ok(notificationFunctions.includes("now - lastAt < 120000"));
});

test('membership lifecycle notifications cover join approval access and assignment changes',()=>{
  for(const token of [
    'teacher_join_request',
    'teacher_approved',
    'teacher_rejected',
    'teacher_disabled',
    'teacher_reactivated',
    'teacher_removed',
    'teacher_assignments_updated'
  ]) assert.ok(notificationFunctions.includes(token),token);
  assert.ok(notificationFunctions.includes("onDocumentWritten"));
  assert.ok(notificationFunctions.includes("'users/{uid}'"));
});

test('notification documents are server-created while users can only mark their own notices read',()=>{
  assert.ok(rules.includes('match /users/{uid}/notifications/{notificationId}'));
  assert.ok(rules.includes("affectedKeys().hasOnly(['read', 'readAt'])"));
  assert.ok(rules.includes('request.resource.data.read == true'));
  assert.ok(rules.includes('request.resource.data.readAt == request.time'));
  assert.ok(rules.includes('allow create, delete: if false;'));
});

test('Head Teacher can send a persisted announcement to active teachers',()=>{
  assert.ok(notificationFunctions.includes('sendSchoolAnnouncement'));
  assert.ok(notificationFunctions.includes("member.role === 'teacher' && member.status === 'active'"));
  assert.ok(app.includes("safetyCall('sendSchoolAnnouncement', { body })"));
  assert.ok(html.includes('Send to active teachers'));
});

test('browser notification support is opt-in and does not replace in-app notifications',()=>{
  assert.ok(app.includes('Notification.requestPermission()'));
  assert.ok(app.includes('registration.showNotification'));
  assert.ok(app.includes("document.visibilityState === 'visible'"));
  assert.ok(sw.includes("event.data?.type==='OPEN_NOTIFICATIONS'") || sw.includes("type:'OPEN_NOTIFICATIONS'"));
  assert.ok(css.includes('/* Notifications / Communication v1 */'));
});

test('FAQ explains notification scope and closed-app limitation',()=>{
  assert.ok(faq.includes('Notifications &amp; communication'));
  assert.ok(faq.includes('Refreshing the page or restoring an already signed-in session does not create a new sign-in notification.'));
  assert.ok(faq.includes('Not in Notifications v1.'));
  assert.equal(hostedFaq,faq);
});

test('functions entry point exports Notifications Communication v1 module',()=>{
  assert.ok(functionsIndex.includes("require('./notifications')"));
  assert.ok(functionsIndex.includes('notificationsModule.register({onCall, HttpsError, db, admin})'));
});
