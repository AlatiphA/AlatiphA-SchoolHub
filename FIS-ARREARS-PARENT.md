# AlatiphA SchoolHub v40 - Arrears Management, Parent Fee Statements and Reminder Generator

## Scope
This phase extends the existing FIS reporting layer without changing the fee ledger schema, Firebase Functions, Firestore rules, payment allocation, reversals, offline queues, or Head Teacher-only financial mutations.

## Arrears Management
- Distinguishes previous-period arrears from current-term outstanding balances.
- Excludes future charges from arrears and due-now views.
- Production fee records are shown by default; test records remain explicitly selectable for internal review only.
- Filters by class, fee category, arrears mode and data mode.
- Searches pupil name, guardian name, parent phone, class, fee category and fee item.
- Shows previous arrears, current outstanding, total amount in view, pupils owing, saved-phone coverage and oldest unpaid period.
- Supports selecting visible pupils, CSV export and printable/PDF arrears lists.
- Uses the pupil's current class for follow-up while retaining the original fee periods on the individual charges.

## Parent Fee Statements
- Renames and enhances the pupil statement as a parent-ready fee statement.
- Uses existing pupil fields: guardianName, parentPhone and admissionId. No new guardian schema is introduced.
- Shows school name, address/email when configured, pupil/class/student ID, guardian details and statement date.
- Separates previous arrears, current outstanding, total due, total paid and balance.
- Defaults to charges due through the current school term, with an option to include future charges.
- Includes charge details, adjustments, payment receipts and void status.
- Supports CSV export and Print / Save as PDF.

## Reminder Generator
- Generates reminders locally from confirmed production FIS balances only.
- Supports one pupil or the pupils selected in Arrears Management.
- Can prepare arrears-only reminders or arrears plus current-term outstanding balances.
- Optional payment deadline and custom note.
- Preview, copy-to-clipboard, WhatsApp deep link, and Print / Save as PDF.
- Ghana local mobile numbers such as 024xxxxxxx are normalized to 23324xxxxxxx for WhatsApp. Already-international numbers are preserved.
- SchoolHub does not send messages automatically.

## Safety and compatibility
- No new financial write path.
- No fee ledger or payment schema changes.
- No Firebase Functions changes.
- No Firestore or Storage rules changes.
- No change to oldest-first/manual payment allocation or receipt reversal logic.
- No change to PWA/background-sync safeguards.
- Reminder generation never includes test fee records.
- Existing FIS cache and silent-refresh behavior are retained.

## Deployment
This phase is client-side only. After the patch passes local regression tests, commit/push the changes and deploy Firebase Hosting only.
