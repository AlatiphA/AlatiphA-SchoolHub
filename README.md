# AlatiphA SchoolHub Phase 3 v34

## v34: Image Sync Diagnostics & Browser Compatibility

- Firestore `schools/{schoolId}/imageAssets` is the authoritative image manifest.
- Firebase Storage remains the binary backup store.
- Browsers synchronize image binaries into IndexedDB from the manifest.
- No Storage folder listing is required for normal synchronization.
- Deterministic legacy paths are probed directly to recover old assets whose manifest metadata was never created.
- Uploads create/update manifest entries for logos, student photos, and staff signatures.
- Re-uploading deterministic assets no longer deletes the newly uploaded replacement.
- System Health tests access to an actual Storage file instead of listing the school folder.
- v30 session/logout protections and v31 Sync Center/System Health are retained.


v33 image recovery:
- Firestore imageAssets remains the cloud manifest.
- Added Head Teacher-only Recover Local Images action in Sync Center.
- This publishes known local IndexedDB images to deterministic Firebase Storage paths and registers/repairs their Firestore metadata.
- Storage folder listing is not required.
- Existing legacy/random cloud files are not deleted.


v34 image synchronization improvements:
- Prefers a fresh Firebase Storage download URL followed by a normal CORS fetch.
- Retains authenticated Storage SDK byte download as a fallback.
- Retains the manifest's download URL as a final fallback.
- Adds per-image diagnostics showing which asset failed and the exact error/attempts.
- Adds a 20-second timeout for direct image fetches to prevent a browser from appearing stuck.
- Keeps Storage rules least-privilege and does not require Storage folder listing.
- v30 session/logout protections and v31-v33 synchronization architecture are retained.
