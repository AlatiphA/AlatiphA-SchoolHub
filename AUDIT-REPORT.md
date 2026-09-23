# SchoolHub safety audit continuation — 23 September 2026

## Release status

Deployed to `alatipha-schoolhub` on 23 September 2026 after explicit approval in this task. All four safety functions are ACTIVE on Node.js 22 in `us-central1`; Hosting and both Firestore/Storage rule sets were released successfully. The live index, app script, and service worker match the local release hashes. All four callable endpoints returned HTTP 401 / UNAUTHENTICATED to unauthenticated requests, without accessing school records. Live checks completed at approximately 17:01 UTC.

The source changes remain in this repository's working tree, based on commit `305a4709f0f8835a9955618173b64be2ff644576`; this task did not commit or push them. The earlier automatic approval rejection was resolved by the user's explicit approval before deployment.

## Completed fixes

- Recovered the interrupted audit and hardening work, then reconciled the published `public` files with the root source.
- Preserved pending edits during cloud hydration and acknowledged only the version actually sent. Per-field writes are serialized, and obsolete sessions cannot acknowledge a newer user's queue.
- Added a durable local save journal containing both the new value and sync queue. Interrupted writes replay at startup. Storage failures retain the saved data/journal and show a save failure message.
- Moved grades, attendance, teacher attendance, and remarks writes into `saveSchoolRecord`. Active membership and class/subject permissions are checked on the server. A three-way merge preserves independent changes and rejects conflicting values. Cleared score fields are removed rather than retained by Firestore merge writes.
- Added deletion markers to explicit pupil/staff/class/bulk deletes. Stale clients cannot recreate marked array records. Record generation checks reject writes from before a clear while allowing fresh entries after the clear is observed. Explicit Head Teacher recovery removes the marker and restores the record in one batch.
- Restricted staff personnel records, teacher attendance, and billing records to Head Teachers. Teachers receive only the staff fields needed for reports through `getSchoolReportStaff`. Student photo Storage paths and image-manifest queries enforce assigned-class access.
- Moved rollover and emergency restore into one server transaction with the protective archive. Failed operations do not partially apply the roster. Rollover retries are idempotent. Restore checks school identity and expected year, retains students added after the backup, and archives the pre-restore state.
- Archives use byte-safe base64 chunks. Oversized operations are rejected before writes: at most 450 planned writes and conservative size guards (6 MiB snapshot, 8 MiB serialized output). Restore counts marker removals too, so its roster limit is lower. These bounds intentionally stop large schools for supervised migration.
- Added `migrateSchoolLegacy` so old school records can migrate under the tightened rules. It preserves existing newer documents and deletion markers, removes legacy embedded collections atomically, and rejects more than 440 planned records.
- Service-worker installation requires the complete static shell before activation. Caching is restricted to the shell and known library hosts; unrelated caches are preserved. Version: `schoolhub-cache-v40-safety-2`.
- Retained the earlier Calendar move/open-date fix, join-code ownership protection, failed-save preservation, and backup safeguards.
- Clarified in the README that billing remains suspended and retained payment code is test-only. No payment endpoint or live billing configuration was changed.

## Validation

- **67 unit/regression tests passed, 0 failed.** Includes server access/conflict/rollover tests, legacy migration, clear/re-entry generation checks, journal replay/corruption, incomplete service-worker install, and the existing feature regressions.
- **9 Firebase emulator/integration tests passed, 0 failed.** Includes class-scoped queries, disabled/foreign users, personnel restrictions, direct-write denial, deletion/recovery, join-code ownership, image manifests/Storage, and real Firestore transactions for migration, grade save, rollover, and restore. Only synthetic data in `demo-schoolhub-audit` was used.
- Changed JavaScript passed syntax checks; `git diff --check` passed.
- All 17 duplicated root/public assets are byte-identical in the final package.
- Local browser: login Help, Privacy, and Terms panels opened successfully; floating navigation was absent from login; no console errors observed during those checks. No production account was used.
- Firebase CLI confirmed all four functions ACTIVE after deployment. Both rules files compiled and were released. Live file hashes matched, and all four callable authentication checks passed. Authenticated production workflows were not run.

Logs: `outputs/unit-tests.txt`, `outputs/emulator-tests.txt`, `outputs/deploy-functions.txt`, `outputs/deploy-hosting.txt`, `outputs/deploy-rules.txt`, and `outputs/live-verification.json`.

## Remaining limitations and recommended follow-ups

This is a targeted repair, not a claim that every possible data-loss or security risk has been eliminated.

1. Real-account, multi-device browser workflows were not exercised against production. Emulator tests cover server behavior; authenticated logout/reconnect, device revocation, large populated reports, and phone layouts still need acceptance testing.
2. Local caches, recovery snapshots, and downloaded backups remain device-accessible by design. Server permission changes cannot revoke copies already downloaded, including existing Firebase download-token URLs. Use trusted devices and protect backup files; stronger shared-device isolation needs a separate design.
3. Three-way conflict handling covers grades, attendance, teacher attendance, and remarks. Ordinary pupil/staff/class/subject upserts and settings retain the existing last-writer behavior. Two editors changing the same entity or settings can still overwrite one another. Add record revisions and a conflict-resolution interface before promising general multi-device conflict safety.
4. Class and bulk deletions remain chunked operations. A later batch failure can leave a partially completed explicit delete, with markers for committed records. Recovery and backups are retained; a resumable delete-job interface would improve clarity for large operations.
5. A genuine record conflict is preserved locally and reported as a sync failure. There is no field-by-field conflict-resolution screen yet; review cloud data and the saved recovery copy before discarding or re-entering values.
6. Large rollover/restore/legacy migrations deliberately stop rather than falling back to partial batches. A supervised server migration is needed when limits are exceeded.
7. PDF rendering still uses raster slicing. Long table rows can split differently from browser print; populated multi-page report visual QA remains outstanding.
8. Existing open tabs running the old app will be denied direct protected-record writes after the new rules deploy. Refresh/reopen the app to load the new version; **do not clear browser storage while pending edits exist**.
9. Narrowing current Storage/manifest permissions does not erase previously cached images or rotate existing download tokens. Broad token rotation would affect live report assets and is outside this patch.

## Deployment and rollback

Use `DEPLOYMENT.md`. Deploy the four new callable functions first, then Hosting, then Firestore/Storage rules in the same release window. Do not publish the new rules if the Functions deployment fails. Keep all parts coordinated: a Hosting-only rollback to an older direct-write client is incompatible with the tightened rules. No production school data was changed by this audit.

References used for deployment and transaction constraints: [Firebase CLI](https://firebase.google.com/docs/cli), [Manage Functions](https://firebase.google.com/docs/functions/manage-functions), and [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions).
