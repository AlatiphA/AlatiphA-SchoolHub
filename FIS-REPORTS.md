# FIS Financial Reports, Pupil Statements and Dashboard Analytics

This release adds read-only financial reporting on top of the existing v40 multi-category FIS. It does not change the Firestore fee schema, Cloud Functions, payment allocation rules, Head Teacher authorization, offline queues, or migration safeguards.

## Added
- Financial dashboard with expected, collected, outstanding, collection rate, arrears, pupils owing, discounts, and added adjustments.
- Filters by academic year, term, class, category, balance status, and production/test data.
- Summary reports by category, class, period, and payment method.
- Detailed CSV export with spreadsheet-formula injection protection.
- Printable financial report suitable for browser Save as PDF.
- Pupil fee statements with charges, adjustments, payments, receipt references, due/paid/balance totals, CSV export, and printable PDF view.
- Statement shortcut from each pupil balance row.
- Filter and statement selection preservation during silent FIS refreshes.

## Safety
- Reports are rendered only inside the existing Head Teacher-only FIS view.
- All figures are derived from the already confirmed FIS ledger returned by getSchoolFees.
- No new financial mutation endpoint was added.
- Test records are excluded from reports by default.
- Existing payment reversals and cancelled charges remain reflected through the ledger balances.

## Validation
- Full final regression suite: 231/231 passed, 0 failed.
- Firebase Functions and Firestore rules are unchanged from the deployed PWA-hardened baseline.
- This release requires Hosting only after local validation and Git commit/push.
