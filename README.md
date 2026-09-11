# AlatiphA SchoolHub Phase 3 v32

## v32: Firestore Image Manifest

- Firestore `schools/{schoolId}/imageAssets` is the authoritative image manifest.
- Firebase Storage remains the binary backup store.
- Browsers synchronize image binaries into IndexedDB from the manifest.
- No Storage folder listing is required for normal synchronization.
- Deterministic legacy paths are probed directly to recover old assets whose manifest metadata was never created.
- Uploads create/update manifest entries for logos, student photos, and staff signatures.
- Re-uploading deterministic assets no longer deletes the newly uploaded replacement.
- System Health tests access to an actual Storage file instead of listing the school folder.
- v30 session/logout protections and v31 Sync Center/System Health are retained.
