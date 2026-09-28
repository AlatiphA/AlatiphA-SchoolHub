# SchoolHub v40 final regression patch

Base: clean local repository commit `2e4629b4acebf4ec2e05b8892c42d89cf09d5a7a`, including hydration/report-asset stability build `v40-hydration-report-assets-fix-7`.

This patch adds release validation only. All existing application, public assets, service-worker versions, Firebase configuration, Functions and security rules are preserved byte for byte. No in-app panel is added: automated checks give useful coverage without introducing application behavior or touching school data.

## Exact changed files

- `package.json`: adds `test:final`.
- `scripts/final-regression.cjs`: dependency-free syntax and complete default test-suite runner, usable from any directory.
- `tests/final-regression.test.cjs`: 53 additional behavioral and packaging checks.
- `FINAL-REGRESSION.md`: this release and deployment report.

## Validation results

- Original baseline: 115 tests passed.
- Final default suite: 168 passed, 0 failed, 0 skipped.
- Syntax: 57 JavaScript files and executable classic inline scripts passed.
- All public files match root counterparts byte for byte; all service-worker shell entries exist.
- Tests use synthetic records and mocked browser/cloud interfaces. They do not access production accounts or change school data.

Run with Node 22 or newer:

```powershell
node scripts/final-regression.cjs
# Alternatively, where npm is installed:
npm run test:final
```

The runner includes every `tests/*.test.cjs` and `functions/*.test.js` file and exits nonzero on syntax or test failure. Existing tests continue to run without alteration.

## Coverage

| Area | Automated coverage |
| --- | --- |
| Head Teacher | All 14 navigation destinations, class/student/subject visibility, existing staff, registration and bulk-operation tests |
| Teacher | Denied administrative routes, permitted teaching routes, assigned class/student/subject filtering, unresolved identity/data guards; existing profile/mobile/startup checks |
| Offline/reconnect | Existing outbox persistence, failed-write retention, newer-edit preservation, stale-session rejection, offline identity reverification and hydration merge tests |
| Reports | Asset timeout/cleanup, bounded concurrency/order, record/cache/offline resolution, missing asset warnings, denied-class check; existing single/batch button and credit/generation tests |
| Subject deletion | Historical zero-score references protected, empty/unused references distinguished; existing deletion and cache safeguards |
| Rollover/restore | Unauthorized action rejection, invalid/unresolved/stale/cancelled/hydrating rollover, malformed/foreign backups, cancelled/hydrating restore and snapshot failure; existing archive protection |
| Themes | Light/dark/system document state, browser bar and accessible label; existing shared CSS-token and responsive style checks |
| PWA | Online shell refresh, offline navigation fallback, failed response protection, private/write request bypass, scoped cache cleanup, existing partial-install guard |
| Packaging | Full root/public byte parity and precache asset existence |

## Validation limits

The separately configured Firebase integration suite (`tests/security-rules.emulator.cjs`) was attempted but could not start: `@firebase/rules-unit-testing` is unavailable in this environment. Firebase CLI and Java were also unavailable on PATH. This is an unverified integration check, not a pass or an intentional skip within the 168-test default suite. In an environment with Java and Firebase CLI installed, run:

```powershell
npm ci
npm run test:rules
```

These tests exercise extracted production functions in isolated contexts and existing source contracts; they are not a real-browser end-to-end certification. Real-device appearance, printed PDF layout, live sign-in/logout, and an installed PWA upgrade still need a brief manual smoke check. No claim of production or visual verification is made.

## Deployment scope

No deployment is required to apply this test-only patch. Commit the four changed files to retain the new release checks. The ZIP includes the complete tracked project, preserving the latest app build and existing Firebase configuration, and excludes Git metadata, caches, dependencies and local data.

If you choose to redeploy the packaged, unchanged app, the scope is **Hosting only**:

```powershell
firebase deploy --only hosting
```

Do not deploy Functions, Firestore rules or Storage rules for this patch. No deployment, commit or push was performed as part of packaging. Do not overwrite unrelated local work when extracting the ZIP.

## Follow-up verification — 27 September 2026

The previous emulator limitation above is resolved on this machine. This follow-up used Node 22, Java 21 and local Firebase emulators with the demo-schoolhub-audit project. Production school records were not changed.

- Main release runner: 172 passed, 0 failed, 0 skipped.
- Firestore/Storage rule integration suite: 11 passed, 0 failed, 0 skipped.
- Added profile coverage: account relinking while editing; save retries; unchanged login identity; atomic rejection of invalid changes; simulated commit failure; pending/rejected account denial.
- Added rule coverage: teachers cannot directly rewrite their Staff link, promote their account, or modify another Staff record.
- Live read-only verification: app-4.js, index.html, ui-polish.css and sw.js match the tested local files on both Firebase Hosting and GitHub Pages.
- No application or security-rule change was needed; this follow-up adds tests only. No new authenticated real-account end-to-end or visual check was performed in this pass.

Evidence: outputs/continued-regression.txt and outputs/continued-rules.txt.
