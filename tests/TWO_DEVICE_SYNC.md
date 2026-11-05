# Paired phone and desktop sync regression checks

Run `node tests/two-device-sync.browser.cjs` with Playwright available in the environment. Set `SCHOOLHUB_BROWSER` to a supported Chromium browser executable if Edge is not installed. Set `SCHOOLHUB_TEST_OUTPUT` to save screenshots.

The test opens isolated browser contexts at 390 and 1280 pixels and runs the shipped grade, calendar, service-access and automatic-sync scripts plus the actual header-status renderer. Both contexts receive shared synthetic server snapshots. No production Firebase accounts or school records are used.

Covered scenarios:

1. Both devices edit the same score: the phone draft survives the PC update, and conflicting saving is blocked.
2. A calendar exception is removed: both registers open the date and show the received teacher attendance.
3. The term changes: an old form cannot save, stale callbacks cannot populate the new term, and reopening receives the new term scores.
4. Access is revoked on the phone: saving is blocked there while the PC remains usable.
5. Header states distinguish connected, paused for editing, offline and saved work needing review.

The ordinary unit suite also checks that unchanged offline forms remain saveable, that account/term context changes block stale forms, and that failed refreshes do not erase drafts. Firebase security and transaction checks are maintained separately in the emulator tests. These browser checks do not replace testing phone-specific browser suspension or push notification behaviour on physical devices.
