# AlatiphA-SchoolHub


## AlatiphA SchoolHub Phase 3

Phase 3 changes school data synchronization from one shared Firestore school document to
school-scoped subcollections:

- `schools/{schoolId}/classes/{classId}`
- `schools/{schoolId}/students/{studentId}`
- `schools/{schoolId}/subjects/{subjectId}`
- `schools/{schoolId}/grades/{gradeId}`
- `schools/{schoolId}/remarks/{remarkId}`
- `schools/{schoolId}/staff/{staffId}`

Teachers are approved by the Head Teacher and receive `assignedClassIds` and
`assignedSubjectIds` on their `users/{uid}` document. The application only loads
assigned class data for teachers, and Firestore Security Rules enforce the same
boundary server-side.

Firebase Storage is used for school logos, signatures, and student photographs.

### Firebase setup

1. Enable Authentication with Email/Password.
2. Create the Firestore database in your chosen region.
3. Enable Cloud Storage.
4. Make sure `firebase-config.js` contains the exact `storageBucket` shown in
   Firebase Console. New default buckets normally use `PROJECT_ID.firebasestorage.app`;
   legacy buckets may use `PROJECT_ID.appspot.com`.
5. Deploy `firestore.rules` and `storage.rules`.


## v17 Teacher ↔ Staff relationship

Approved SchoolHub teacher accounts in `users/{uid}` are now linked one-to-one with personnel records in `schools/{schoolId}/staff/{staffId}`. The relationship is stored as `users.staffId` and `staff.userUid`. Manage Teachers can create or link the Staff record while approving or managing a teacher. Staff records remain independent of account status so disabling a teacher does not delete report-card personnel history or signatures.


## v21 report image and teacher-link fixes / school creation
- School creation now restores users/{uid} when a signed-in account has lost its Firestore user profile.
- The initial join code can be created by the authenticated school owner without requiring users/{uid} to exist first.


## v23 local-first image architecture
- Structured application data stays in localStorage.
- Logo, student photos, and staff signatures are stored in IndexedDB only.
- Firebase Storage remains the cloud binary backup.
- Existing v21/v22 localStorage image-cache entries are migrated to IndexedDB and removed.
- Deterministic Storage paths prevent repeated uploads for the same asset from creating new objects.
- About shows version, browser, image-cache count, local-storage usage, and service-worker state.
- Check for Updates now reports the actual service-worker update failure when available.


## v24
- Reliable cloud-to-browser image reconciliation through IndexedDB.
- Image inventory and explicit Sync Images action.
- About reports cloud image count and last image-sync time.
- Service worker cache advanced to v24.
- Structured application data remains in localStorage; image binaries remain in IndexedDB.


## v25
- Firebase Storage-aware image discovery in addition to Firestore image metadata.
- Deterministic student photo and staff signature paths are discovered directly from Storage.
- Missing Firestore photo/signature metadata can be repaired from Storage by the Head Teacher.
- Cloud image inventory now merges Firestore metadata with actual Storage objects.
- Sync Images reports metadata repairs as well as downloads.
- Reports remain local-first through IndexedDB.


V28 - Security/session loading improvement
- Authentication and role resolution no longer wait for image synchronization.
- Image sync runs in the background after the dashboard is ready.
- Reports can synchronize a missing image on demand.
- Image binaries remain in IndexedDB; structured localStorage records remain image-free.


## v28 Session Loading Fix

v28 separates authentication/role readiness from core cloud synchronization. After Firebase Auth and the user role/school are resolved, the authentication gate is released immediately. Core school data loads in the background, while the dashboard shows a neutral loading state and does not render previous-session school records until the new session data is ready. Image synchronization remains background work.
