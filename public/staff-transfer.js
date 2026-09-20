/* Staff spreadsheet validation and non-destructive merging. */
(function (root) {
  const normalize = value => String(value == null ? '' : value).trim().toLowerCase();
  function columns(fields) {
    return [{ key: 'name', label: 'Full name' }, { key: 'staffId', label: 'Staff ID' },
      { key: 'role', label: 'Role', type: 'select', options: ['Teacher', 'Head Teacher', 'Assistant Head Teacher', 'Other'].map(v => [v, v]) },
      ...fields.filter(f => f.key !== 'staffId')];
  }
  function plan(rows, existing, fields) {
    const schema = columns(fields), errors = [], changes = [];
    if (!rows.length) return { errors: ['The file is empty.'], changes };
    const header = rows[0].map(normalize);
    const indexes = new Map();
    for (const field of schema) {
      const matches = header.map((h, i) => h === normalize(field.label) || h === normalize(field.key) ? i : -1).filter(i => i >= 0);
      if (matches.length > 1) errors.push(`Duplicate column: ${field.label}.`);
      if (matches.length) indexes.set(field.key, matches[0]);
    }
    if (!indexes.has('name') || !indexes.has('staffId')) errors.push('Full name and Staff ID columns are required. Use the staff template.');
    if (errors.length) return { errors, changes };
    const seen = new Set();
    rows.slice(1).forEach((row, index) => {
      if (row.every(v => !String(v == null ? '' : v).trim())) return;
      const rowNumber = index + 2, values = {};
      for (const field of schema) {
        if (!indexes.has(field.key)) continue;
        let value = String(row[indexes.get(field.key)] ?? '').trim();
        if (!value) continue; // Blank cells never erase an existing detail.
        if (field.type === 'select') {
          const option = field.options.find(([v, label]) => normalize(v) === normalize(value) || normalize(label) === normalize(value));
          if (!option) errors.push(`Row ${rowNumber}: invalid ${field.label} “${value}”.`);
          else value = option[0];
        }
        if (field.type === 'date') {
          const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
          const date = match ? new Date(`${value}T00:00:00Z`) : null;
          if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) errors.push(`Row ${rowNumber}: ${field.label} must be a valid YYYY-MM-DD date.`);
        }
        if (field.key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`Row ${rowNumber}: invalid email address.`);
        if (value.length > 500) errors.push(`Row ${rowNumber}: ${field.label} is too long.`);
        values[field.key] = value;
      }
      if (!values.name || !values.staffId) { errors.push(`Row ${rowNumber}: Full name and Staff ID are required.`); return; }
      const key = normalize(values.staffId);
      if (seen.has(key)) { errors.push(`Row ${rowNumber}: duplicate Staff ID ${values.staffId} in this file.`); return; }
      seen.add(key);
      const matches = existing.filter(s => normalize(s.staffId) === key);
      if (matches.length > 1) { errors.push(`Row ${rowNumber}: Staff ID ${values.staffId} matches multiple existing records. Correct those records first.`); return; }
      changes.push({ rowNumber, values, existingId: matches[0]?.id || null });
    });
    if (!changes.length && !errors.length) errors.push('The file contains no staff rows.');
    return { errors, changes };
  }
  function merge(existing, changes, makeId) {
    const result = existing.map(s => ({ ...s }));
    for (const change of changes) {
      if (change.existingId) {
        const record = result.find(s => s.id === change.existingId);
        if (!record) throw new Error('Staff records changed. Preview the file again.');
        Object.assign(record, change.values);
      } else result.push({ id: makeId(), role: 'Teacher', ...change.values });
    }
    return result;
  }
  const api = { columns, plan, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StaffTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
