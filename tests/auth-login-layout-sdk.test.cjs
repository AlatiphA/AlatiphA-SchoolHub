const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const root = fs.readFileSync('index.html', 'utf8');
const hosted = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('app-4.js', 'utf8');

function pos(html, token) {
  const index = html.indexOf(token);
  assert.notEqual(index, -1, `Missing ${token}`);
  return index;
}

test('email sign in and sign up stay primary while Google appears below them', () => {
  const email = pos(root, 'id="authEmail"');
  const submit = pos(root, 'id="authSubmitBtn"');
  const toggle = pos(root, 'id="authToggleModeBtn"');
  const divider = pos(root, '<span>or continue with Google</span>');
  const google = pos(root, 'id="authGoogleBtn"');
  const guest = pos(root, 'id="authGuestBtn"');
  assert.ok(email < submit && submit < toggle && toggle < divider && divider < google && google < guest);
  assert.equal((root.match(/id="authGoogleBtn"/g) || []).length, 1);
  assert.equal((root.match(/id="authSubmitBtn"/g) || []).length, 1);
});

test('Firebase compat browser SDKs are consistently upgraded to 12.19.0', () => {
  for (const module of ['app', 'auth', 'firestore', 'storage', 'functions']) {
    assert.ok(root.includes(`https://www.gstatic.com/firebasejs/12.19.0/firebase-${module}-compat.js`), module);
  }
  assert.ok(!root.includes('firebasejs/12.17.1/'));
  assert.equal((root.match(/firebasejs\/12\.19\.0\//g) || []).length, 5);
});

test('hosting mirror and existing Google sign-in behavior remain intact', () => {
  assert.equal(hosted, root);
  assert.ok(app.includes("provider.setCustomParameters({ prompt: 'select_account' });"));
  assert.ok(app.includes('firebase.auth().signInWithPopup(provider)'));
  assert.ok(app.includes('firebase.auth().signInWithEmailAndPassword(email, password)'));
  assert.ok(app.includes('firebase.auth().createUserWithEmailAndPassword(email, password)'));
});