# SchoolHub safety release

Target: `alatipha-schoolhub`. **Deployed successfully on 23 September 2026 after explicit user approval.** All four functions are ACTIVE; Hosting and Firestore/Storage rules were released. Live file hashes and unauthenticated rejection checks passed. The commands below document how to reproduce this release. Source changes remain uncommitted in the working tree.

Use Node 22 for the Functions project, an authenticated Firebase CLI, and Java 21+ for emulator tests. The four new callables use `us-central1`: `saveSchoolRecord`, `getSchoolReportStaff`, `applySchoolYearChange`, and `migrateSchoolLegacy`. Existing billing functions are excluded from deployment.

## Validate

```powershell
Set-Location -LiteralPath 'C:\AlatiphA\AlatiphA-SchoolHub'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Validation dependency installation failed.' }
npm ci --prefix functions
if ($LASTEXITCODE -ne 0) { throw 'Functions dependency installation failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed.' }
npm run test:rules
if ($LASTEXITCODE -ne 0) { throw 'Emulator tests failed.' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Diff checks failed.' }
git diff --stat
git status --short
```

Expected: 67 unit tests and 9 emulator/integration tests pass. On this Windows machine, Java needed a short writable socket directory. If the same loopback error occurs, create `outputs` and set this **process-local** option before the emulator command:

```powershell
New-Item -ItemType Directory -Force outputs | Out-Null
$env:JAVA_TOOL_OPTIONS = '-Djdk.net.unixdomain.tmpdir=C:/AlatiphA/AlatiphA-SchoolHub/outputs'
```

## Record the reviewed change

Preserve and reconcile unrelated work. Do not use `git restore .` as cleanup.

```powershell
git add -- .gitignore README.md AUDIT-REPORT.md DEPLOYMENT.md package.json package-lock.json firebase.audit.json app-4.js public/app-4.js sw.js public/sw.js public/install.js public/staff-transfer.js firestore.rules storage.rules functions/index.js functions/safety.js functions/safety.test.js tests/bw-allowance.test.cjs tests/v40-offline-first-auth.test.cjs tests/v40-year-rollover.test.cjs tests/v40-audit-behavior.test.cjs tests/sync-journal.test.cjs tests/security-rules.emulator.cjs
if ($LASTEXITCODE -ne 0) { throw 'Staging failed.' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged checks failed.' }
git commit -m "Harden SchoolHub sync, permissions and year-end transactions"
if ($LASTEXITCODE -ne 0) { throw 'Commit failed.' }
git push origin HEAD
if ($LASTEXITCODE -ne 0) { throw 'Push failed.' }
```

## Deployment commands

```powershell
firebase deploy --project alatipha-schoolhub --only "functions:saveSchoolRecord,functions:getSchoolReportStaff,functions:applySchoolYearChange,functions:migrateSchoolLegacy" --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Functions deployment failed. Stop here.' }
firebase deploy --project alatipha-schoolhub --only hosting --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Hosting deployment failed. Stop here.' }
firebase deploy --project alatipha-schoolhub --only "firestore:rules,storage" --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Rules deployment failed. The release is incomplete.' }
```

After deployment, verify all four callables, the published app/service-worker contents, and real-account role/sync workflows. Ask users to refresh/reopen old tabs without clearing storage. Do not perform a production rollover merely as a smoke test; use a staging school for destructive acceptance scenarios.

Keep a coordinated rollback plan. Old clients require their previous direct-write rules, so reverting Hosting alone is not a complete rollback. A rules rollback would reopen the repaired access risks and requires separate review. A release rollback never restores school records.


## Follow-up: sync notice and report buttons (23 September 2026)

The earlier safety release was recorded in commit b8166c7. The follow-up changes in the working tree have NOT been published by this task: automatic approval review was unavailable because its usage limit was reached.

- Fixed undefined academic-year references in both current-term report buttons.
- Added progress and visible error handling to current and historical PDF buttons.
- Added a Report ready panel with Save PDF and Open / Print PDF links to the same prepared file, with no repeated credit deduction.
- Moved the sync notice below the header and distinguished automatic saving from a failed sync.
- Updated the service-worker cache version to v40-sync-reports-3.

Validation: 72 automated tests pass. Isolated browser checks generated PDFs for all eight themes and showed single and class-batch save/print controls. The phone-width profile menu stayed accessible. Browser automation policy blocked the PDF viewer, so the final print dialog was not verified. No school records or live credits were modified by the sample-data checks.

The static website package is outputs/SchoolHub-Sync-Reports-Fix.zip. Publish its contents to the existing GitHub Pages site as well as Firebase Hosting; both use the same already-deployed Firebase backend. This follow-up does not change cloud rules or functions. Reopen or refresh existing app tabs after publishing; do not clear site data, because pending local edits must be retained.
