(function (root) {
  'use strict';

  function initSchoolHubFaqFilters(scope) {
    const container = scope || root.document;
    const search = container.querySelector('#faqSearch');
    const audience = container.querySelector('#faqAudience');
    const status = container.querySelector('#faqSearchStatus');
    const grid = container.querySelector('.inline-faq-grid');
    if (!search || !audience || !status || !grid || grid.dataset.filtersReady === 'true') return;
    grid.dataset.filtersReady = 'true';
    const sections = Array.from(grid.querySelectorAll('.inline-doc-section'));
    const answers = Array.from(grid.querySelectorAll('details'));
    const roleAnswers = new Map([
      ['what can a teacher access?', ['teacher']],
      ['where is parent portal?', ['headteacher', 'parent']],
      ['does saving attendance also change class remarks?', ['headteacher', 'teacher']],
      ['what can the head teacher record?', ['headteacher']],
      ['can a teacher and head teacher mark at the same time?', ['headteacher', 'teacher']],
      ['what can a parent see in the parent portal?', ['parent']],
      ['how does the head teacher invite a parent?', ['headteacher', 'parent']],
      ['why did my parent portal invitation code stop working?', ['parent']],
      ['does communications send email automatically?', ['headteacher']],
      ['when does the head teacher receive notifications?', ['headteacher']],
      ['what notifications can a teacher receive?', ['teacher']],
      ['can the head teacher send an announcement?', ['headteacher']]
    ]);

    function audiencesFor(answer) {
      if (answer.dataset.faqAudience) return answer.dataset.faqAudience.split(/\s+/).filter(Boolean);
      const question = answer.querySelector('summary')?.textContent.trim().toLocaleLowerCase();
      return roleAnswers.get(question) || [];
    }

    function applyFilters() {
      const query = search.value.trim().toLocaleLowerCase();
      const role = audience.value;
      let visible = 0;
      answers.forEach(answer => {
        const roles = audiencesFor(answer);
        const roleMatches = role === 'all' || roles.length === 0 || roles.includes('all') || roles.includes(role);
        const textMatches = !query || answer.textContent.toLocaleLowerCase().includes(query);
        answer.hidden = !(roleMatches && textMatches);
        if (!answer.hidden) visible += 1;
      });
      sections.forEach(section => {
        section.hidden = !Array.from(section.querySelectorAll('details')).some(answer => !answer.hidden);
      });
      status.textContent = visible
        ? `Showing ${visible} of ${answers.length} answers.`
        : 'No matching answers. Try a broader search or choose All roles.';
    }

    search.addEventListener('input', applyFilters);
    audience.addEventListener('change', applyFilters);
    applyFilters();
  }

  root.initSchoolHubFaqFilters = initSchoolHubFaqFilters;
  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', () => initSchoolHubFaqFilters(root.document), { once: true });
  } else {
    initSchoolHubFaqFilters(root.document);
  }
})(window);
