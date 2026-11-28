(function () {
  const DEFAULT_TEMPLATES = [
    { id: 'absence-alert', name: 'Absence alert', channel: 'Attendance', subject: '{First} was absent today ({Date})', body: 'Dear {Guardian},\n\n{First} was marked absent from {Class} today. If you have not told us the reason yet, please reply to this e-mail or call the school office.\n\nKind regards,\n{School}\n{Contact}' },
    { id: 'at-risk', name: 'At-risk learner', channel: 'Learner support', subject: '{First} · a word about this term', body: 'Dear {Guardian},\n\nWe would like to talk with you about how {First} is doing this term:\n{Details}\n\nPlease call the school office or reply to this e-mail so we can agree a time to meet.\n\nKind regards,\n{School}\n{Contact}' },
    { id: 'report-card', name: 'Report card', channel: 'Reports', subject: "{First}'s {Term} report card", body: 'Dear {Guardian},\n\nPlease review {First}\'s report card for {Term}.\n\nKind regards,\n{School}\n{Contact}' },
    { id: 'fee-reminder', name: 'Fee reminder', channel: 'Fees & Receipts', subject: '{Term} fees reminder · {First}', body: 'Dear {Guardian},\n\nOur records show that {Overdue} remains outstanding for {First} {Last} of {Class}. The balance due is {Balance}, payable by {Due}.\n\nIf you have already paid, please ignore this message. If you would like to discuss a payment plan, please call or reply to this e-mail.\n\nKind regards,\n{School}\n{Contact}' }
  ];
  const TAG_GUIDE = [
    ['Guardian', 'Parent/Guardian name'], ['First', 'Learner first name'], ['Last', 'Learner surname'],
    ['Class', 'Learner’s class'], ['Date', 'Today’s date'], ['Term', 'Current term and year'],
    ['Details', 'Details entered for this message'], ['Balance', 'Balance entered for this message'],
    ['Overdue', 'Overdue amount entered for this message'], ['Due', 'Payment deadline entered for this message'],
    ['School', 'School name'], ['Contact', 'School email or phone']
  ];

  function loadTemplates() {
    const saved = DB.get(KEYS.settings, {}).communicationTemplates;
    return DEFAULT_TEMPLATES.map(template => {
      const override = Array.isArray(saved) ? saved.find(item => item && item.id === template.id) : null;
      return Object.assign({}, template, override || {});
    });
  }

  function writeTemplates(templates) {
    const settings = DB.get(KEYS.settings, {});
    settings.communicationTemplates = templates.map(({ id, subject, body }) => ({ id, subject, body }));
    DB.set(KEYS.settings, settings);
  }

  function prettyDate(value) {
    if (!value) return '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00') : new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GH', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function renderSchoolCommunications() {
    const host = document.getElementById('communicationsWrap');
    if (!host) return;
    if (typeof isHeadTeacher !== 'function' || !isHeadTeacher()) {
      host.innerHTML = '<p class="empty">Communications templates are managed by the Head Teacher.</p>';
      return;
    }

    const templates = loadTemplates();
    const students = DB.get(KEYS.students, []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const classes = DB.get(KEYS.classes, []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const settings = DB.get(KEYS.settings, {});
    const esc = value => escapeHtml(String(value == null ? '' : value));
    const options = classes.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    const pupilOptions = students.map(item => `<option value="${esc(item.id)}" data-class="${esc(item.classId)}" data-parent-email="${esc(item.parentEmail || '')}">${esc(item.name || 'Unnamed learner')} · ${esc(classes.find(c => String(c.id) === String(item.classId))?.name || 'No class')}</option>`).join('');

    host.innerHTML = `
      <section class="communication-intro">
        <p>Prepare a message using a saved template. SchoolHub fills in learner and school details, then opens Email or WhatsApp sharing options for you to review.</p>
        <p class="hint">Choose a learner to use their saved parent contact. Publish a reviewed report PDF to the linked Parent Portal from the Report ready window. Email drafts remain available; a configured school mail service can also send the published PDF directly after your review.</p>
      </section>
      <div class="communication-layout">
        <section class="communication-card">
          <h3>Prepare a message</h3>
          <div class="communication-form-grid">
            <label>Template<select id="communicationTemplateSelect">${templates.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>
            <p class="hint communication-template-hint">Only the fill-in fields used by this template are shown.</p>
            <label>Class filter<select id="communicationClassSelect"><option value="">All classes</option>${options}</select></label>
            <label class="communication-wide">Learner<select id="communicationPupilSelect"><option value="">Choose a learner</option>${pupilOptions}</select></label>
            <label class="communication-wide">Parent/Guardian email recipient (optional)<input id="communicationRecipient" type="email" maxlength="254" placeholder="parent@example.com" autocomplete="email"></label>
            <button type="button" id="communicationInviteParent" class="btn-secondary communication-wide">Open this learner in Parent Portal</button>
            <p id="communicationAttachmentHint" class="hint communication-wide" hidden>SchoolHub prepares the selected learner’s report PDF. The device share sheet can include it as an attachment; if file sharing is unavailable, attach the downloaded PDF before sending.</p>
            <label class="communication-template-input" data-template-field="details" hidden>Details<input id="communicationDetails" type="text" placeholder="Optional note"></label>
            <label class="communication-template-input" data-template-field="balance" hidden>Balance<input id="communicationBalance" type="text" inputmode="decimal" placeholder="e.g. GH₵ 250.00"></label>
            <label class="communication-template-input" data-template-field="overdue" hidden>Overdue amount<input id="communicationOverdue" type="text" inputmode="decimal" placeholder="e.g. GH₵ 100.00"></label>
            <label class="communication-template-input" data-template-field="due" hidden>Payment due date<input id="communicationDue" type="date"></label>
          </div>
          <div class="communication-preview" aria-live="polite">
            <div><span class="communication-label">Subject</span><strong id="communicationPreviewSubject">Choose a template</strong></div>
            <div><span class="communication-label">Message</span><pre id="communicationPreviewBody">Choose a learner to preview the completed message.</pre></div>
            <p id="communicationMissingTags" class="hint" role="status"></p>
          </div>
          <div class="communication-actions">
            <button type="button" id="communicationCopyBtn" class="btn-secondary">Copy message</button>
            <div class="communication-share">
              <button type="button" id="communicationShareBtn" class="btn-primary" aria-expanded="false" aria-controls="communicationShareOptions">Share</button>
              <div id="communicationShareOptions" class="communication-share-options" role="group" aria-label="Choose a sharing method" hidden>
                <button type="button" class="btn-secondary" data-share-channel="email">Email</button>
                <button type="button" class="btn-secondary" data-share-channel="whatsapp">WhatsApp</button>
              </div>
            </div>
          </div>
          <a id="communicationContinueLink" class="btn-secondary communication-continue" hidden></a>
          <p id="communicationStatus" class="hint" role="status" aria-live="polite"></p>
        </section>

        <aside class="communication-card communication-tags-card">
          <h3>Available tags</h3>
          <p class="hint">Tags in braces are filled in when you choose a learner. Choose a template to show only the fill-in fields it uses.</p>
          <dl>${TAG_GUIDE.map(([tag, meaning]) => `<div><dt>{${esc(tag)}}</dt><dd>${esc(meaning)}</dd></div>`).join('')}</dl>
        </aside>
      </div>

      <details class="communication-editor">
        <summary>Edit message templates</summary>
        <p class="hint">Changes are saved with this school and sync to its other devices when connected.</p>
        <label>Template to edit<select id="communicationEditSelect">${templates.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>
        <label>Email subject<input id="communicationSubjectTemplate" type="text" maxlength="180"></label>
        <label>Message<textarea id="communicationBodyTemplate" rows="8" maxlength="5000"></textarea></label>
        <div class="communication-actions">
          <button type="button" id="communicationSaveTemplateBtn" class="btn-primary">Save template</button>
          <button type="button" id="communicationRestoreTemplateBtn" class="btn-secondary">Restore this template</button>
        </div>
        <p id="communicationTemplateStatus" class="hint" role="status" aria-live="polite"></p>
      </details>`;

    const byId = id => host.querySelector('#' + id);
    const templateSelect = byId('communicationTemplateSelect');
    const editSelect = byId('communicationEditSelect');
    const classSelect = byId('communicationClassSelect');
    const pupilSelect = byId('communicationPupilSelect');
    const subjectEditor = byId('communicationSubjectTemplate');
    const bodyEditor = byId('communicationBodyTemplate');
    const status = byId('communicationStatus');
    const shareButton = byId('communicationShareBtn');
    const shareOptions = byId('communicationShareOptions');
    const continueLink = byId('communicationContinueLink');
    const templateStatus = byId('communicationTemplateStatus');
    const templateInputFields = [...host.querySelectorAll('[data-template-field]')];
    let selectedTemplateId = templates[0]?.id || '';

    function templateById(id) { return templates.find(item => item.id === id) || templates[0]; }
    function updateTemplateInputVisibility(subject, body) {
      const usedTags = new Set([subject, body].flatMap(text => [...String(text || '').matchAll(/\{([^{}]+)\}/g)].map(match => match[1].trim().toLowerCase())));
      templateInputFields.forEach(field => { field.hidden = !usedTags.has(field.dataset.templateField); });
    }
    function loadEditor(id) {
      const item = templateById(id);
      if (!item) return;
      editSelect.value = item.id;
      subjectEditor.value = item.subject;
      bodyEditor.value = item.body;
      const attachmentHint=byId('communicationAttachmentHint');
      if(attachmentHint)attachmentHint.hidden=item.id!=='report-card';
      selectedTemplateId = item.id;
      templateSelect.value = item.id;
      updatePreview();
    }

    function tagValues() {
      const pupil = students.find(item => String(item.id) === pupilSelect.value);
      const schoolClass = pupil && classes.find(item => String(item.id) === String(pupil.classId));
      const nameParts = String(pupil?.name || '').trim().split(/\s+/).filter(Boolean);
      return {
        guardian: pupil?.guardianName || 'Parent/Guardian',
        first: nameParts[0] || '', last: nameParts.slice(1).join(' '),
        class: schoolClass?.name || '', date: prettyDate(new Date().toISOString().slice(0, 10)),
        term: [settings.currentTerm, settings.currentYear].filter(Boolean).join(' '),
        details: byId('communicationDetails').value.trim(),
        balance: byId('communicationBalance').value.trim(),
        overdue: byId('communicationOverdue').value.trim(),
        due: prettyDate(byId('communicationDue').value),
        school: settings.schoolName || 'School', contact: settings.email || settings.phone || 'the school office'
      };
    }

    function fillTags(text, values) {
      const missing = new Set();
      const rendered = String(text || '').replace(/\{([^{}]+)\}/g, (token, label) => {
        const key = String(label).trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(values, key) || !String(values[key] || '').trim()) { missing.add(token); return token; }
        return String(values[key]);
      });
      return { rendered, missing: [...missing] };
    }

    function updatePreview() {
      const item = templateById(templateSelect.value || selectedTemplateId);
      const subjectTemplate = subjectEditor?.value ?? item?.subject ?? '';
      const bodyTemplate = bodyEditor?.value ?? item?.body ?? '';
      updateTemplateInputVisibility(subjectTemplate, bodyTemplate);
      const values = tagValues();
      const subject = fillTags(subjectTemplate, values);
      const body = fillTags(bodyTemplate, values);
      byId('communicationPreviewSubject').textContent = subject.rendered || '—';
      byId('communicationPreviewBody').textContent = body.rendered || '—';
      const missing = [...new Set([...subject.missing, ...body.missing])];
      byId('communicationMissingTags').textContent = missing.length
        ? `Complete these fields to fill the remaining tag${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
        : '';
      return { subject: subject.rendered, body: body.rendered, missing };
    }

    function emailDraftUrl(recipient, result) {
      return `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(result.subject)}&body=${encodeURIComponent(result.body)}`;
    }
    function whatsappDraftUrl(digits, result) {
      const message = `${result.subject}\n\n${result.body}`;
      return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
    }
    function clearContinueLink() {
      continueLink.hidden = true;
      continueLink.removeAttribute('href');
      continueLink.textContent = '';
    }
    function openShareDestination(channel, recipient, phone, result) {
      if (channel === 'email') {
        window.location.href = emailDraftUrl(recipient, result);
      } else {
        const link = document.createElement('a');
        link.href = whatsappDraftUrl(phone, result);
        link.target = '_blank';
        link.rel = 'noopener';
        link.click();
      }
    }

    shareButton.addEventListener('click', () => {
      const expanded = shareButton.getAttribute('aria-expanded') === 'true';
      shareButton.setAttribute('aria-expanded', String(!expanded));
      shareOptions.hidden = expanded;
    });
    shareOptions.addEventListener('click', async event => {
      const option = event.target.closest('[data-share-channel]');
      if (!option) return;
      const channel = option.dataset.shareChannel;
      const result = updatePreview();
      const studentId = pupilSelect.value;
      const recipient = byId('communicationRecipient').value.trim();
      shareOptions.hidden = true;
      shareButton.setAttribute('aria-expanded', 'false');
      clearContinueLink();
      if (!studentId) { status.textContent = 'Choose a learner first.'; return; }
      const student = DB.get(KEYS.students, []).find(item => String(item.id) === studentId);
      if (!student) { status.textContent = 'Reopen Communications and select the learner again.'; return; }
      const phone = guardianWhatsAppDigits(student.parentPhone);
      if (result.missing.length) { status.textContent = 'Complete the highlighted fields before sharing.'; return; }
      if (channel === 'email' && recipient && !byId('communicationRecipient').checkValidity()) { status.textContent = 'Enter a valid parent email address, or leave it blank and add it in your email app.'; return; }
      if (channel === 'whatsapp' && !phone) { status.textContent = guardianPhoneHelp(student); return; }

      if (templateSelect.value !== 'report-card') {
        openShareDestination(channel, recipient, phone, result);
        status.textContent = channel === 'email'
          ? 'Email draft opened. Review the parent address and message, then send it from your email app.'
          : 'WhatsApp opened with the message prepared. Review it and choose the parent chat before sending.';
        return;
      }

      if (typeof window.generateCommunicationReport !== 'function') { status.textContent = 'Report sharing is unavailable until the report tools finish loading. Refresh and try again.'; return; }
      status.textContent = 'Preparing the learner’s report card…';
      option.disabled = true;
      shareButton.disabled = true;
      shareButton.textContent = 'Preparing PDF…';
      try {
        const showFallback = () => {
          continueLink.href = channel === 'email' ? emailDraftUrl(recipient, result) : whatsappDraftUrl(phone, result);
          continueLink.target = '_blank';
          continueLink.rel = 'noopener';
          continueLink.textContent = channel === 'email' ? 'Continue to email draft' : 'Continue to WhatsApp';
          continueLink.hidden = false;
          status.textContent = channel === 'email'
            ? 'This device could not attach the PDF directly. In the Report ready window, tap Save PDF, then open the parent email draft and attach the saved file before sending.'
            : 'This device could not attach the PDF directly. In the Report ready window, tap Save PDF, then open the parent WhatsApp chat and attach the saved file before sending.';
        };
        const onShareResult = shareState => {
          if (shareState === 'shared') status.textContent = 'The device share sheet handed off the PDF. Check the email or WhatsApp app and confirm it was sent; SchoolHub cannot confirm delivery.';
          else if (shareState === 'cancelled') status.textContent = 'The share sheet was closed. Check the target app; SchoolHub cannot confirm whether anything was sent.';
          else if (shareState === 'fallback') showFallback();
        };
        const outcome = await window.generateCommunicationReport(studentId, {
          channel, recipient, subject: result.subject,
          text: channel === 'whatsapp' ? `${result.subject}\n\n${result.body}` : result.body,
          onResult: onShareResult
        });
        if (outcome === 'ready') {
          status.textContent = channel === 'email'
            ? `The PDF is ready. Tap Share PDF in the Report ready window, choose your email app, then enter ${recipient || 'the parent’s email address'}. SchoolHub cannot confirm delivery.`
            : 'The PDF is ready. Tap Share PDF in the Report ready window, choose WhatsApp, then select the parent chat. SchoolHub cannot confirm delivery.';
        } else if (outcome === 'fallback') {
          showFallback();
        } else {
          status.textContent = 'The report was not shared. Check the report message and try again.';
        }
      } catch (error) {
        console.error('Unable to share report card:', error);
        status.textContent = 'Unable to prepare this report card. Check the report access and try again.';
      } finally {
        option.disabled = false;
        shareButton.disabled = false;
        shareButton.textContent = 'Share';
      }
    });

    templateSelect.addEventListener('change', () => loadEditor(templateSelect.value));
    editSelect.addEventListener('change', () => loadEditor(editSelect.value));
    classSelect.addEventListener('change', () => {
      [...pupilSelect.options].forEach(option => {
        if (!option.value) return;
        option.hidden = !!classSelect.value && option.dataset.class !== classSelect.value;
      });
      if (pupilSelect.selectedOptions[0]?.hidden) { pupilSelect.value = ''; byId('communicationRecipient').value = ''; }
      updatePreview();
    });
    pupilSelect.addEventListener('change', () => {
      byId('communicationRecipient').value=pupilSelect.selectedOptions[0]?.dataset.parentEmail||'';
      updatePreview();
    });
    ['communicationRecipient', 'communicationDetails', 'communicationBalance', 'communicationOverdue', 'communicationDue'].forEach(id => byId(id).addEventListener('input', updatePreview));
    subjectEditor.addEventListener('input', updatePreview);
    bodyEditor.addEventListener('input', updatePreview);

    byId('communicationSaveTemplateBtn').addEventListener('click', () => {
      const id = editSelect.value;
      const item = templateById(id);
      if (!item) return;
      const subject = subjectEditor.value.trim();
      const body = bodyEditor.value.trim();
      if (!subject || !body) { templateStatus.textContent = 'Enter both a subject and a message before saving.'; return; }
      item.subject = subject;
      item.body = body;
      writeTemplates(templates);
      selectedTemplateId = id;
      templateSelect.value = id;
      templateStatus.textContent = 'Template saved for this school.';
      updatePreview();
    });

    byId('communicationRestoreTemplateBtn').addEventListener('click', () => {
      const id = editSelect.value;
      const original = DEFAULT_TEMPLATES.find(item => item.id === id);
      if (!original) return;
      if (!window.confirm('Restore this template to its default? Your saved edits to this template will be replaced.')) return;
      const restored = Object.assign({}, original);
      templates.splice(templates.findIndex(item => item.id === id), 1, restored);
      writeTemplates(templates);
      loadEditor(id);
      templateStatus.textContent = 'Default template restored.';
    });

    byId('communicationCopyBtn').addEventListener('click', async () => {
      const result = updatePreview();
      if (!pupilSelect.value) { status.textContent = 'Choose a learner first.'; return; }
      if (result.missing.length) { status.textContent = 'Complete the highlighted tag fields before copying.'; return; }
      try {
        await navigator.clipboard.writeText(`Subject: ${result.subject}\n\n${result.body}`);
        status.textContent = 'Message copied. Review it before sharing.';
      } catch (_) { status.textContent = 'Could not copy automatically. Select and copy the preview text.'; }
    });
    byId('communicationInviteParent').addEventListener('click', () => {
      if (!pupilSelect.value) { status.textContent = 'Choose a learner first.'; return; }
      window.openLearnerParentPortal?.(pupilSelect.value);
    });

    const intent = window.schoolHubCommunicationIntent;
    window.schoolHubCommunicationIntent = null;
    loadEditor(templates.some(item => item.id === intent?.templateId) ? intent.templateId : selectedTemplateId);
    if (intent?.studentId && students.some(item => String(item.id) === intent.studentId)) {
      const pupil = students.find(item => String(item.id) === intent.studentId);
      classSelect.value = String(pupil.classId || '');
      classSelect.dispatchEvent(new Event('change'));
      pupilSelect.value = intent.studentId;
      pupilSelect.dispatchEvent(new Event('change'));
    }
  }

  window.renderSchoolCommunications = renderSchoolCommunications;
})();
