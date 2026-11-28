'use strict';

(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const callable = name => firebase.functions().httpsCallable(name);

  async function refreshParentPortalManager() {
    const host = document.getElementById('parentPortalManager');
    if (!host) return;
    const status = host.querySelector('#parentManagerStatus');
    const list = host.querySelector('#parentManagerLinks');
    if (status) status.textContent = 'Loading linked families…';
    try {
      const result = await callable('getParentPortalOverview')({ expectedSchoolId: currentSchoolId });
      if (!host.isConnected || !list) return;
      const parents = result.data?.parents || [];
      list.innerHTML = parents.length ? parents.map(parent => `
        <article class="parent-managed-link">
          <div><strong>${escape(parent.email || 'Parent account')}</strong>${parent.students.map(student => `<p>${escape(student.name)} · ${escape(student.className)} <button class="parent-revoke" type="button" data-parent-uid="${escape(parent.uid)}" data-student-id="${escape(student.id)}">Remove access</button></p>`).join('')}</div>
        </article>`).join('') : '<p class="parent-empty">No parent accounts are linked yet.</p>';
      if (status) status.textContent = parents.length ? `${parents.length} parent account${parents.length === 1 ? '' : 's'} linked.` : 'Parent access is ready to set up.';
      list.querySelectorAll('.parent-revoke').forEach(button => button.addEventListener('click', async () => {
        const studentName = button.parentElement?.textContent?.split(' · ')[0] || 'this learner';
        if (!confirm(`Remove this parent’s access to ${studentName}?`)) return;
        button.disabled = true;
        try {
          await callable('revokeParentPortalLink')({ expectedSchoolId: currentSchoolId, parentUid: button.dataset.parentUid, studentId: button.dataset.studentId });
          await refreshParentPortalManager();
        } catch (error) {
          button.disabled = false;
          if (status) status.textContent = error.message || 'Could not remove parent access.';
        }
      }));
    } catch (error) {
      if (status) status.textContent = error.message || 'Could not load parent links. Check your connection and retry.';
    }
  }

  function renderParentPortalManager() {
    const host = document.getElementById('parentPortalManager');
    if (!host || !window.firebase || !currentSchoolId) return;
    const students = (DB.get(KEYS.students, []) || []).filter(student => student && student.id && student.isActive !== false)
      .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    host.innerHTML = `
      <div class="parent-manager-grid">
        <section class="parent-card">
          <h3>Invite a parent or guardian</h3>
          <p class="parent-muted">Choose a learner to prefill the saved Parent/Guardian Email, or enter another address. Share the generated code and Parent Portal link privately. The parent must create an account with this same verified email.</p>
          <form id="parentInviteForm" class="parent-form">
            <label>Learner<select id="parentInviteStudent" required><option value="">Select learner</option>${students.map(student => {
              const cls = (DB.get(KEYS.classes, []) || []).find(item => item.id === student.classId);
              return `<option value="${escape(student.id)}" data-parent-email="${escape(student.parentEmail || '')}">${escape(student.name || 'Unnamed learner')} · ${escape(cls?.name || 'Class not set')}</option>`;
            }).join('')}</select></label>
            <label>Parent/guardian email<input id="parentInviteEmail" type="email" maxlength="254" autocomplete="email" required placeholder="parent@example.com"></label>
            <button class="parent-primary" id="parentInviteSubmit" type="submit">Create invitation</button>
          </form>
          <div id="parentInviteResult"></div>
        </section>
        <section class="parent-card">
          <h3>Linked families</h3>
          <p id="parentManagerStatus" class="parent-muted" role="status" aria-live="polite">Loading…</p>
          <div id="parentManagerLinks"></div>
          <button class="parent-secondary" id="parentManagerRefresh" type="button">Refresh list</button>
        </section>
      </div>`;

    const form = host.querySelector('#parentInviteForm');
    const inviteStudent = host.querySelector('#parentInviteStudent');
    const inviteEmail = host.querySelector('#parentInviteEmail');
    const output = host.querySelector('#parentInviteResult');
    const submit = host.querySelector('#parentInviteSubmit');
    const status = host.querySelector('#parentManagerStatus');
    inviteStudent?.addEventListener('change', () => {
      if (inviteEmail) inviteEmail.value = inviteStudent.selectedOptions[0]?.dataset.parentEmail || '';
    });
    const intent = window.schoolHubParentPortalIntent;
    window.schoolHubParentPortalIntent = null;
    if (intent?.studentId && students.some(student => String(student.id) === intent.studentId)) {
      inviteStudent.value = intent.studentId;
      inviteStudent.dispatchEvent(new Event('change'));
    }
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      const studentId = host.querySelector('#parentInviteStudent')?.value || '';
      const email = host.querySelector('#parentInviteEmail')?.value || '';
      if (!studentId || !email) return;
      submit.disabled = true;
      submit.textContent = 'Creating invitation…';
      if (output) output.replaceChildren();
      try {
        const result = await callable('createParentPortalInvitation')({ expectedSchoolId: currentSchoolId, studentId, email });
        const code = result.data?.inviteCode || '';
        const until = result.data?.expiresAtMs ? new Date(result.data.expiresAtMs).toLocaleString() : 'in seven days';
        const portalUrl = new URL('./parent.html', location.href).href;
        if (output) output.innerHTML = `<div class="parent-code-panel"><strong>Invitation ready for ${escape(result.data?.studentName || 'learner')}</strong><p>Issued to ${escape(email.trim())}. It expires ${escape(until)}. Ask the parent to open this page and sign up with that email:</p><p><a href="${escape(portalUrl)}">${escape(portalUrl)}</a></p><p>One-time invitation code</p><code id="parentInviteCodeOutput">${escape(code)}</code><button class="parent-secondary" type="button" id="parentCopyInviteCode">Copy invitation code</button><p class="parent-muted">The code is shown once. Keep it private and do not post it publicly.</p></div>`;
        output.querySelector('#parentCopyInviteCode')?.addEventListener('click', async event => {
          const button = event.currentTarget;
          try { await navigator.clipboard.writeText(code); button.textContent = 'Copied'; }
          catch { button.textContent = 'Select and copy the code above'; output.querySelector('#parentInviteCodeOutput')?.focus(); }
        });
        if (status) status.textContent = 'Invitation created. The code is available only in this message.';
      } catch (error) {
        if (status) status.textContent = error.message || 'Could not create the invitation.';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create invitation';
      }
    });
    host.querySelector('#parentManagerRefresh')?.addEventListener('click', refreshParentPortalManager);
    refreshParentPortalManager();
  }

  window.renderParentPortalManager = renderParentPortalManager;

  const root = document.getElementById('parentPortalApp');
  if (!root) return;

  const authBox = document.getElementById('parentPortalAuth');
  const verifyBox = document.getElementById('parentPortalVerify');
  const claimBox = document.getElementById('parentPortalClaim');
  const dataBox = document.getElementById('parentPortalData');
  const statusBox = document.getElementById('parentPortalStatus');
  const authForm = document.getElementById('parentAuthForm');
  let creatingAccount = false;
  let busy = false;

  function setStatus(message, state = '') {
    statusBox.textContent = message;
    statusBox.dataset.state = state;
    statusBox.hidden = !message;
  }
  function hideAll() { authBox.hidden = true; verifyBox.hidden = true; claimBox.hidden = true; dataBox.hidden = true; }
  function money(cents) {
    return new Intl.NumberFormat('en-GH', { style: 'currency', currency: 'GHS', minimumFractionDigits: 2 }).format(Number(cents || 0) / 100);
  }
  function displayDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return String(date || '—');
    const [year, month, day] = date.split('-').map(Number);
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(year, month - 1, day));
  }
  function humanStatus(status) {
    const code = String(status || '').toUpperCase();
    return ({ P: 'Present', L: 'Late', A: 'Absent', E: 'Excused', O: 'On leave', S: 'On strike' })[code]
      || code.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()) || '—';
  }
  function renderParentData(data, user) {
    const cards = document.getElementById('parentLearnerCards');
    document.getElementById('parentSignedInEmail').textContent = user.email || '';
    cards.innerHTML = (data.students || []).map(student => {
      const attendance = (data.attendance || []).filter(row => row.studentId === student.id);
      const count = key => attendance.filter(row => String(row.status).toUpperCase() === key).length;
      const fees = (data.fees || []).find(row => row.studentId === student.id) || {};
      const grades = (data.grades || []).filter(row => row.studentId === student.id).sort((a, b) => `${b.year}${b.term}`.localeCompare(`${a.year}${a.term}`));
      const reports = (data.reports || []).filter(row => row.studentId === student.id).sort((a, b) => `${b.year}${b.term}`.localeCompare(`${a.year}${a.term}`));
      const publishedReports = (data.publishedReports || []).filter(row => row.studentId === student.id);
      const attendanceRows = attendance.slice(0, 18).map(row => `<tr><td>${escape(displayDate(row.date))}</td><td>${escape(row.term)} ${escape(row.year)}</td><td>${escape(humanStatus(row.status))}</td></tr>`).join('');
      const gradeSections = grades.map(sheet => `<section><h4 class="parent-section-title">${escape(sheet.term)} ${escape(sheet.year)}</h4><div class="parent-table-wrap"><table class="parent-table"><thead><tr><th>Subject</th><th>Class score / 60</th><th>Exam score / 100</th></tr></thead><tbody>${(sheet.subjects || []).map(mark => `<tr><td>${escape(mark.subject)}</td><td>${mark.classScore == null ? '—' : escape(mark.classScore)}</td><td>${mark.examScore == null ? '—' : escape(mark.examScore)}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
      const reportSections = reports.map(report => {
        const notes = [['Attendance', report.attendance], ['Promotion', report.promoted], ['Conduct', report.conduct], ['Attitude', report.attitude], ['Interest', report.interest], ['Teacher comment', report.comment]].filter(([, value]) => String(value || '').trim());
        return notes.length ? `<section><h4 class="parent-section-title">Report comments · ${escape(report.term)} ${escape(report.year)}</h4>${notes.map(([label, value]) => `<div class="parent-report-note"><strong>${escape(label)}</strong>${escape(value)}</div>`).join('')}</section>` : '';
      }).join('');
      return `<article class="parent-learner-card">
        <div class="parent-learner-heading"><div><h2>${escape(student.name)}</h2><p>${escape(student.className)}${student.admissionId ? ` · ID ${escape(student.admissionId)}` : ''}</p></div><span>${escape(data.currentTerm)} ${escape(data.currentYear)}</span></div>
        <div class="parent-kpis">
          <div class="parent-kpi"><span>Attendance this year</span><strong>${attendance.length} recorded</strong></div>
          <div class="parent-kpi"><span>Present + late</span><strong>${count('P') + count('L')}</strong></div>
          <div class="parent-kpi"><span>Absent</span><strong>${count('A')}</strong></div>
          <div class="parent-kpi"><span>Fee balance</span><strong>${money(fees.totalBalance)}</strong></div>
          <div class="parent-kpi"><span>Current term</span><strong>${money(fees.currentTermBalance)}</strong></div>
          <div class="parent-kpi"><span>Previous balance</span><strong>${money(fees.previousBalance)}</strong></div>
        </div>
        <h3 class="parent-section-title">Attendance</h3>
        ${attendanceRows ? `<div class="parent-table-wrap"><table class="parent-table"><thead><tr><th>Date</th><th>Term</th><th>Status</th></tr></thead><tbody>${attendanceRows}</tbody></table></div>` : '<p class="parent-empty">No attendance has been recorded for this academic year.</p>'}
        <h3 class="parent-section-title">Published report cards</h3>
        ${publishedReports.length ? publishedReports.map(report => `<div class="parent-report-note"><strong>${escape(report.term)} ${escape(report.year)}</strong><button type="button" class="parent-secondary parent-report-download" data-report-id="${escape(report.reportId)}">Download PDF</button></div>`).join('') : '<p class="parent-empty">The school has not published a report card for this learner yet.</p>'}
        <h3 class="parent-section-title">Grades</h3>
        ${gradeSections || '<p class="parent-empty">No saved grades are available for this learner yet.</p>'}
        <h3 class="parent-section-title">Report comments</h3>
        ${reportSections || '<p class="parent-empty">No report comments are available yet.</p>'}
      </article>`;
    }).join('') || '<div class="parent-card"><p>No learner is currently linked to this account. Contact the school.</p></div>';
    cards.querySelectorAll('.parent-report-download').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Preparing PDF…';
      try {
        const response = await callable('getParentReportCard')({ reportId: button.dataset.reportId });
        const encoded = response.data?.pdfBase64 || '';
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = response.data?.filename || 'SchoolHub_report.pdf';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        setStatus('Report PDF downloaded. Open it to read or print.', 'success');
      } catch (error) {
        setStatus(error.message || 'Could not download this report. Check your connection and try again.', 'error');
      } finally {
        button.disabled = false;
        button.textContent = 'Download PDF';
      }
    }));
    document.querySelector('.parent-portal-intro > p:last-child').textContent = `${data.schoolName} · Attendance, published report cards, grades, report comments and fee balance`;
    dataBox.hidden = false;
  }

  async function loadParentData(user) {
    hideAll();
    setStatus('Loading your linked learner information…');
    try {
      const result = await callable('getParentPortalData')({});
      renderParentData(result.data || {}, user);
      setStatus('Information updated from the school.', 'success');
    } catch (error) {
      setStatus(error.message || 'Could not load your learner information. Check your connection and retry.', 'error');
      dataBox.hidden = false;
      document.getElementById('parentLearnerCards').innerHTML = '<div class="parent-card"><p>Your saved access remains with the school. Use Refresh to try again.</p></div>';
    }
  }

  async function showSignedIn(user) {
    hideAll();
    if (!user.emailVerified) {
      verifyBox.hidden = false;
      document.getElementById('parentVerifyText').textContent = `We sent a verification link to ${user.email || 'your email'}. Verify it, then return here and check again.`;
      setStatus('Email verification is required before linking a learner.', 'error');
      return;
    }
    try {
      await user.getIdToken(true);
      const profileSnap = await firebase.firestore().collection('users').doc(user.uid).get({ source: 'server' });
      const profile = profileSnap.exists ? profileSnap.data() || {} : null;
      if (profile?.role === 'parent' && profile.status === 'active') {
        await loadParentData(user);
        return;
      }
      if (profile && profile.role !== 'parent' && profile.schoolId && ['active', 'pending', 'disabled'].includes(profile.status)) {
        hideAll();
        authBox.hidden = false;
        setStatus('This sign-in belongs to a school staff account. Sign out and use a separate parent email account.', 'error');
        return;
      }
      claimBox.hidden = false;
      setStatus('Enter the one-time invitation code from your school.');
    } catch (error) {
      authBox.hidden = false;
      setStatus(error.message || 'Could not confirm your account. Check your connection and retry.', 'error');
    }
  }

  function updateAuthMode() {
    document.getElementById('parentAuthTitle').textContent = creatingAccount ? 'Create parent account' : 'Sign in';
    document.getElementById('parentConfirmWrap').hidden = !creatingAccount;
    document.getElementById('parentAuthSubmit').textContent = creatingAccount ? 'Create account' : 'Sign in';
    document.getElementById('parentAuthMode').textContent = creatingAccount ? 'I already have an account' : 'Create parent account';
    document.getElementById('parentForgotPassword').hidden = creatingAccount;
    document.getElementById('parentPassword').autocomplete = creatingAccount ? 'new-password' : 'current-password';
  }

  document.getElementById('parentAuthMode').addEventListener('click', () => { creatingAccount = !creatingAccount; updateAuthMode(); });
  authForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const email = document.getElementById('parentEmail').value.trim();
    const password = document.getElementById('parentPassword').value;
    const confirmPassword = document.getElementById('parentConfirmPassword').value;
    const button = document.getElementById('parentAuthSubmit');
    button.disabled = true;
    try {
      if (creatingAccount) {
        if (password !== confirmPassword) throw new Error('The passwords do not match.');
        const credential = await firebase.auth().createUserWithEmailAndPassword(email, password);
        await credential.user.sendEmailVerification();
        setStatus(`Verification email sent to ${email}. Open it, verify your address, then return here.`, 'success');
      } else {
        await firebase.auth().signInWithEmailAndPassword(email, password);
      }
    } catch (error) {
      setStatus(error.message || 'Could not sign in. Check the email and password.', 'error');
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
  document.getElementById('parentForgotPassword').addEventListener('click', async () => {
    const email = document.getElementById('parentEmail').value.trim();
    if (!email) { setStatus('Enter your email address first.', 'error'); return; }
    try { await firebase.auth().sendPasswordResetEmail(email); setStatus(`Password reset instructions sent to ${email}.`, 'success'); }
    catch (error) { setStatus(error.message || 'Could not send password reset instructions.', 'error'); }
  });
  document.getElementById('parentResendVerification').addEventListener('click', async () => {
    try { await firebase.auth().currentUser.sendEmailVerification(); setStatus('A new verification email has been sent.', 'success'); }
    catch (error) { setStatus(error.message || 'Could not send the verification email.', 'error'); }
  });
  document.getElementById('parentCheckVerification').addEventListener('click', async () => {
    try { await firebase.auth().currentUser.reload(); if (firebase.auth().currentUser.emailVerified) await showSignedIn(firebase.auth().currentUser); else setStatus('Your email is not verified yet. Open the link in your inbox and try again.', 'error'); }
    catch (error) { setStatus(error.message || 'Could not check email verification.', 'error'); }
  });
  document.getElementById('parentVerifySignOut').addEventListener('click', () => firebase.auth().signOut());
  document.getElementById('parentClaimSignOut').addEventListener('click', () => firebase.auth().signOut());
  document.getElementById('parentClaimInvite').addEventListener('click', async event => {
    const button = event.currentTarget;
    const inviteCode = document.getElementById('parentInviteCode').value.trim();
    if (!inviteCode || busy) { setStatus('Paste the invitation code from your school.', 'error'); return; }
    busy = true; button.disabled = true;
    try {
      await callable('claimParentPortalInvitation')({ inviteCode });
      document.getElementById('parentInviteCode').value = '';
      await showSignedIn(firebase.auth().currentUser);
      setStatus('Learner linked. Your information is ready.', 'success');
    } catch (error) { setStatus(error.message || 'Could not link the learner. Check the code and verified email.', 'error'); }
    finally { busy = false; button.disabled = false; }
  });
  document.getElementById('parentRefresh').addEventListener('click', () => {
    const user = firebase.auth().currentUser;
    if (user) loadParentData(user);
  });
  document.getElementById('parentPrint').addEventListener('click', () => window.print());
  document.getElementById('parentSignOut').addEventListener('click', () => firebase.auth().signOut());

  updateAuthMode();
  if (!window.firebase || !window.FIREBASE_CONFIG) {
    hideAll(); authBox.hidden = false; setStatus('The Parent Portal could not connect to SchoolHub.', 'error'); return;
  }
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
  firebase.auth().onAuthStateChanged(user => {
    if (user) showSignedIn(user);
    else { hideAll(); authBox.hidden = false; setStatus('Sign in with your parent account or create one using the email issued by the school.'); }
  });
})();
