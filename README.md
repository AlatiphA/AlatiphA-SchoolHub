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


## v19 report image and teacher-link fixes / school creation
- School creation now restores users/{uid} when a signed-in account has lost its Firestore user profile.
- The initial join code can be created by the authenticated school owner without requiring users/{uid} to exist first.
