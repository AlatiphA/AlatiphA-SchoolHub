# AlatiphA SchoolHub v40 PWA hardening

This update strengthens the existing offline-first architecture without replacing the current data model, FIS ledger, durable local outbox, reconnect validation, or financial safeguards.

## Service-worker lifecycle

- Replaces the silent one-line registration with managed registration.
- Registers `sw.js` with `updateViaCache: 'none'`.
- Tracks `updatefound`, installing-worker state changes, waiting workers, and `controllerchange`.
- Records registration/update errors so System Health can report them instead of silently ignoring them.
- Performs a low-frequency update check every six hours, plus a foreground check when the previous check is stale.
- The About update button now uses the same managed update path.
- A newly activated worker does not force an automatic page reload, preserving unsaved/in-progress work. SchoolHub reports that an update is ready instead.

## Native Background Sync coordination

- Uses the browser `SyncManager` when available with tag `schoolhub-pending-sync-v1`.
- Existing SchoolHub local queues remain authoritative. No new financial or school-data write format was introduced.
- General school-data changes still use the v40 durable outbox and existing cloud-write functions.
- FIS pending requests retain their existing request IDs, head-teacher checks, server ownership, and idempotency.
- The service worker receives the `sync` event and asks an active SchoolHub client to run the same authenticated flush paths already used by reconnect recovery.
- The worker waits for a client acknowledgement before considering the sync event complete.
- If the browser does not provide Background Sync, the existing `online` event and reopen/reconnect recovery remain unchanged.

## Important closed-app limitation

The existing authoritative queues are stored in page-owned browser storage and authenticated writes are deliberately performed through the signed-in SchoolHub page. A service worker cannot safely perform those page-owned authenticated mutations by itself without moving/mirroring queue data and authentication into a worker-accessible architecture. This update therefore does not bypass that boundary.

If a Background Sync event fires while no SchoolHub client is available, the event is rejected so the browser may retry it. The durable queue remains intact and will still synchronize on the normal reconnect/reopen path. This preserves the current safeguards rather than inventing a second financial/data-write engine inside `sw.js`.

## Cache version

`schoolhub-cache-v40-pwa-sync-1`

## Validation

`npm run test:final`

Result: 225 tests passed, 0 failed.

No Functions, Firestore rules, Storage rules, or FIS data model changes are part of this update. Deployment is Hosting-only after commit/push.
