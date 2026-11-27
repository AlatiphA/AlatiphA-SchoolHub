(function () {
  const DEFAULT_TEMPLATES = [
    { id: 'absence-alert', name: 'Absence alert', channel: 'Attendance', subject: '{First} was absent today ({Date})', body: 'Dear {Guardian},\n\n{First} was marked absent from {Class} today. If you have not told us the reason yet, please reply to this e-mail or call the school office.\n\nKind regards,\n{School}\n{Contact}' },
    { id: 'at-risk', name: 'At-risk learner', channel: 'Learner support', subject: '{First} · a word about this term', body: 'Dear {Guardian},\n\nWe would like to talk with you about how {First} is doing this term:\n{Details}\n\nPlease call the school office or reply to this e-mail so we can agree a time to meet.\n\nKind regards,\n{School}\n{Contact}' },
    { id: 'report-card', name: 'Report card', channel: 'Reports', subject: "{First}'s {Term} report card", body: 'Dear {Guardian},\n\nPlease find {First}\'s {Term} report card attached.\n\nKind regards,\n{School}\n{Contact}' },
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
        <p>Prepare a message using a saved template. SchoolHub fills in learner and school details, then opens a draft in your email app for you to review.</p>
        <p class="hint">Choose a learner to fill the recipient from the saved Parent/Guardian Email; you can change it before opening the draft. SchoolHub opens but does not send emails. Report-card PDFs must be attached manually in your email app.</p>
      </section>
      <div class="communication-layout">
        <section class="communication-card">
          <h3>Prepare a message</h3>
          <div class="communication-form-grid">
            <label>Template<select id="communicationTemplateSelect">${templates.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>
            <label>Class filter<select id="communicationClassSelect"><option value="">All classes</option>${options}</select></label>
            <label class="communication-wide">Learner<select id="communicationPupilSelect"><option value="">Choose a learner</option>${pupilOptions}</select></label>
            <label class="communication-wide">Parent/Guardian email recipient (optional)<input id="communicationRecipient" type="email" maxlength="254" placeholder="parent@example.com" autocomplete="email"></label>
            <p id="communicationAttachmentHint" class="hint communication-wide" hidden>Before sending this report-card draft, attach the generated report-card PDF in your email app.</p>
            <label>Details<input id="communicationDetails" type="text" placeholder="Optional note"></label>
            <label>Balance<input id="communicationBalance" type="text" inputmode="decimal" placeholder="e.g. GH₵ 250.00"></label>
            <label>Overdue amount<input id="communicationOverdue" type="text" inputmode="decimal" placeholder="e.g. GH₵ 100.00"></label>
            <label>Payment due date<input id="communicationDue" type="date"></label>
          </div>
          <div class="communication-preview" aria-live="polite">
            <div><span class="communication-label">Subject</span><strong id="communicationPreviewSubject">Choose a template</strong></div>
            <div><span class="communication-label">Message</span><pre id="communicationPreviewBody">Choose a learner to preview the completed message.</pre></div>
            <p id="communicationMissingTags" class="hint" role="status"></p>
          </div>
          <div class="communication-actions">
            <button type="button" id="communicationCopyBtn" class="btn-secondary">Copy message</button>
            <button type="button" id="communicationDraftBtn" class="btn-primary">Open email draft</button>
          </div>
          <p id="communicationStatus" class="hint" role="status" aria-live="polite"></p>
        </section>

        <aside class="communication-card communication-tags-card">
          <h3>Available tags</h3>
          <p class="hint">Tags in braces are filled in when you choose a learner. Add the other details above when needed.</p>
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
    const templateStatus = byId('communicationTemplateStatus');
    let selectedTemplateId = templates[0]?.id || '';

    function templateById(id) { return templates.find(item => item.id === id) || templates[0]; }
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
      const values = tagValues();
      const subject = fillTags(subjectEditor?.value ?? item?.subject ?? '', values);
      const body = fillTags(bodyEditor?.value ?? item?.body ?? '', values);
      byId('communicationPreviewSubject').textContent = subject.rendered || '—';
      byId('communicationPreviewBody').textContent = body.rendered || '—';
      const missing = [...new Set([...subject.missing, ...body.missing])];
      byId('communicationMissingTags').textContent = missing.length
        ? `Complete these fields to fill the remaining tag${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
        : '';
      return { subject: subject.rendered, body: body.rendered, missing };
    }

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

    byId('communicationDraftBtn').addEventListener('click', () => {
      const result = updatePreview();
      if (!pupilSelect.value) { status.textContent = 'Choose a learner first.'; return; }
      if (result.missing.length) { status.textContent = 'Complete the highlighted tag fields before opening the draft.'; return; }
      const recipient = byId('communicationRecipient').value.trim();
      if (recipient && !byId('communicationRecipient').checkValidity()) { status.textContent = 'Enter a valid email address, or leave it blank and add the address in your email app.'; return; }
      const draftUrl = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(result.subject)}&body=${encodeURIComponent(result.body)}`;
      window.location.href = draftUrl;
      status.textContent = recipient ? 'Email draft opened. Review the recipient and message before sending.' : 'Email draft opened. Add the guardian’s address and review the message before sending.';
    });

    loadEditor(selectedTemplateId);
  }

  window.renderSchoolCommunications = renderSchoolCommunications;
})();
