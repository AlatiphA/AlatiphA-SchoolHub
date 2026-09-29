# AlatiphA SchoolHub v40 FIS Upgrade

Date: 29 September 2026

## Status

This build upgrades the v40 Fees and Receipts module from the single class-fee ledger to a multi-category fee-item ledger while retaining the existing v40 safety model and backward compatibility.

No Firebase deployment and no Git push were performed.

## Implemented FIS capabilities

- Reusable fee categories, including active/inactive state and safe editing.
- Multiple fee items for each term and academic year.
- Fee scopes for one class, multiple classes, all classes, and an individual pupil.
- Separate pupil charge records with due, paid, and balance values.
- Automatic oldest-first payment allocation across outstanding charges.
- Manual payment allocation to selected pupil fee items.
- Receipts that preserve an allocation snapshot by fee item, category, term/year, and amount.
- Signed pupil adjustments, including discounts and additional charges, with required reasons.
- Arrears summaries grouped by fee category and term/year.
- Revision-safe fee-item editing and guarded cancellation.
- Payment void/reversal with allocation reversal.
- Additive migration of existing v40 fee accounts. Legacy records are retained, not deleted.
- Compatibility mirroring for migrated v40 fee accounts so older v40 clients and queued operations cannot silently diverge from the new ledger during the transition.
- Active Head Teacher authorization for financial mutations.
- Test Data Cleanup that selects only records explicitly flagged as test data and protects production records.
- Mobile-friendly FIS cards, forms, allocation controls, tables, and receipt layouts.
- Explicit Firestore client denial for FIS financial collections. Financial access continues through authenticated callable Functions.
- Existing report-card fee-balance integration retained.
- Offline queue and idempotent request-ID safeguards retained.

## New data model

The upgraded FIS uses these school subcollections:

- `feeCategories`
- `feeItems`
- `pupilCharges`
- `feePayments`
- `feeEvents`
- `feeMeta`

The existing `feeAccounts` collection is retained for v40 compatibility and no-data-loss migration.

## Migration behavior

Migration is additive and idempotent. Existing v40 fee accounts are copied into the new fee-item and pupil-charge model without deleting the source records. A system legacy category is used for migrated records. The UI flushes queued v40 fee requests before migration and blocks new FIS financial mutations if legacy migration is still incomplete.

Migrated charges continue to mirror compatible adjustments, payments, and reversals to the retained v40 fee account. This protects older installed clients and pending offline operations during the transition period.

## Safety behavior

- Financial mutations require an authenticated active Head Teacher.
- Direct client reads and writes to FIS financial collections are denied by Firestore rules.
- Fee item changes use revision checks to reject stale edits.
- A fee item cannot be cancelled when linked charges contain paid money.
- A fee item amount or negative adjustment cannot reduce effective due below money already paid.
- Payment retries use request IDs and do not create duplicate receipts.
- Payment voids are idempotent and reverse the original allocation safely.
- Manual allocations must equal the payment amount and cannot exceed charge balances.
- Test Data Cleanup requires the exact confirmation phrase `CLEAN TEST DATA` and only removes documents explicitly marked `isTestData: true`.

## Regression result

`npm run test:final` passed on this build:

- JavaScript syntax checks: 68 files/inline scripts passed
- Tests: 216
- Passed: 216
- Failed: 0

The suite includes the original v40 tests plus new FIS tests for category reuse, all four fee scopes, revision-safe edits, discounts, automatic and manual payment allocation, receipt allocations, reversal, legacy migration, arrears summaries, test-only cleanup, Head Teacher authorization, mobile UI hooks, Firestore collection guards, service-worker cache changes, and offline compatibility.

## Firebase rules emulator gate

The source still contains the existing `npm run test:rules` emulator test and it has been extended to cover `feeCategories`, `feeItems`, and `pupilCharges` in addition to the existing protected financial collections.

The emulator command could not be executed in the packaging environment because the Firebase CLI executable is not installed there. Java is present. This was an environment limitation, not a failing rule assertion.

Before any future deployment, run:

```powershell
npm run test:rules
```

Only deploy after that command also passes in the normal SchoolHub Firebase development environment.

## Validation commands

```powershell
npm test
npm run test:final
npm run test:rules
```

The first two passed in the packaging environment. The third remains the deployment gate described above.
