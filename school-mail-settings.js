'use strict';

(() => {
  const callable = (name, data = {}) => firebase.functions().httpsCallable(name)({ expectedSchoolId: currentSchoolId, ...data });
  let rendering = 0;

  async function renderSchoolMailSettings() {
    const wrap = document.getElementById('schoolMailSettingsWrap');
    if (!wrap) return;
    const token = ++rendering;
    if (!isHeadTeacher() || !currentSchoolId) {
      wrap.textContent = 'Only an active Head Teacher can connect the school email.';
      return;
    }
    wrap.textContent = 'Checking this school’s outgoing email…';
    let status;
    try { status = (await callable('getSchoolMailStatus')).data; }
    catch (error) { if (token === rendering) wrap.textContent = error.message || 'Could not check outgoing email. Reconnect and try again.'; return; }
    if (token !== rendering) return;
    wrap.innerHTML = `<div class="school-mail-panel">
      <p id="schoolMailState" role="status"></p>
      <p class="hint">The address in <strong>Setup → School Email</strong> is the address parents must see as the sender. SchoolHub can send from it only after you connect and verify that mailbox. The account password is sent securely to the server and is never saved in this browser.</p>
      <form id="schoolMailConnectForm" autocomplete="off">
        <label>School email<input id="schoolMailFrom" type="email" readonly></label>
        <label>Mail provider<select id="schoolMailProvider"><option value="gmail">Gmail or Google Workspace</option><option value="smtp">Other provider with SMTP</option></select></label>
        <div id="schoolMailSmtpFields" hidden>
          <label>Outgoing server<input id="schoolMailHost" type="text" inputmode="url" placeholder="smtp.example.org" maxlength="253" spellcheck="false"></label>
          <label>Port<select id="schoolMailPort"><option value="465">465 (SSL)</option><option value="587">587 (STARTTLS)</option></select></label>
        </div>
        <label>Outgoing account username<input id="schoolMailUser" type="text" autocomplete="off" maxlength="254" spellcheck="false"></label>
        <label>App password or outgoing mail password<input id="schoolMailPassword" type="password" autocomplete="new-password" maxlength="256"></label>
        <p class="hint">For Gmail, sign in to the school's Google account and create an app password with 2-Step Verification. Do not enter your personal Gmail password or another school's account. For other providers, use the outgoing server details supplied by that provider.</p>
        <button class="btn-primary" type="submit">Send verification code</button>
      </form>
      <form id="schoolMailConfirmForm" hidden autocomplete="off">
        <p>Check the verification email in the school inbox. Confirm that its <strong>From</strong> address is the school address shown above, then enter the code.</p>
        <label>Six-digit code<input id="schoolMailCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>
        <button class="btn-primary" type="submit">Confirm school sender</button>
      </form>
      <button id="schoolMailDisconnect" class="btn-secondary" type="button" hidden>Disconnect school sender</button>
      <p id="schoolMailFeedback" role="status" aria-live="polite"></p>
    </div>`;
    const from = wrap.querySelector('#schoolMailFrom');
    const user = wrap.querySelector('#schoolMailUser');
    const provider = wrap.querySelector('#schoolMailProvider');
    const fields = wrap.querySelector('#schoolMailSmtpFields');
    const connectForm = wrap.querySelector('#schoolMailConnectForm');
    const confirmForm = wrap.querySelector('#schoolMailConfirmForm');
    const disconnect = wrap.querySelector('#schoolMailDisconnect');
    const feedback = wrap.querySelector('#schoolMailFeedback');
    const schoolEmail = String(status?.schoolEmail || '');
    from.value = schoolEmail;
    user.value = schoolEmail;
    wrap.querySelector('#schoolMailState').textContent = status?.configured
      ? `Connected. Report emails are sent from ${status.from}.`
      : status?.pending ? `Verification pending for ${schoolEmail}. Direct email is off until confirmed.`
        : `Direct email is off for ${schoolEmail || 'this school'}. Share PDF remains available.`;
    connectForm.hidden = !!status?.configured || !schoolEmail;
    confirmForm.hidden = !status?.pending;
    disconnect.hidden = !status?.configured && !status?.pending;
    const toggle = () => { fields.hidden = provider.value !== 'smtp'; };
    provider.addEventListener('change', toggle);
    toggle();
    connectForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = connectForm.querySelector('button[type="submit"]');
      button.disabled = true;
      feedback.textContent = 'Checking the outgoing account and sending a code to the school inbox…';
      const data = { provider: provider.value, user: user.value.trim(), password: wrap.querySelector('#schoolMailPassword').value,
        host: wrap.querySelector('#schoolMailHost').value.trim(), port: Number(wrap.querySelector('#schoolMailPort').value) };
      try {
        await callable('beginSchoolMailConnection', data);
        wrap.querySelector('#schoolMailPassword').value = '';
        if (token === rendering) await renderSchoolMailSettings();
      } catch (error) {
        wrap.querySelector('#schoolMailPassword').value = '';
        feedback.textContent = error.message || 'Could not send the verification code. Check the outgoing account details.';
        button.disabled = false;
      }
    });
    confirmForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = confirmForm.querySelector('button[type="submit"]');
      button.disabled = true;
      feedback.textContent = 'Confirming the school sender…';
      try { await callable('confirmSchoolMailConnection', { code: wrap.querySelector('#schoolMailCode').value.trim() });
        if (token === rendering) await renderSchoolMailSettings();
      } catch (error) { feedback.textContent = error.message || 'The code was not confirmed.'; button.disabled = false; }
    });
    disconnect.addEventListener('click', async () => {
      if (!confirm('Disconnect this school’s outgoing email? Direct report email will stop until a sender is connected again.')) return;
      disconnect.disabled = true;
      try { await callable('disconnectSchoolMailConnection'); if (token === rendering) await renderSchoolMailSettings(); }
      catch (error) { feedback.textContent = error.message || 'Could not disconnect the sender.'; disconnect.disabled = false; }
    });
  }

  window.renderSchoolMailSettings = renderSchoolMailSettings;
})();
