# AlatiphA SchoolHub Phase 3 v38

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


## v38 - Transaction-safe local-first image uploads

Image uploads are now local-first. The selected image is read and committed to IndexedDB before Firebase Storage is contacted. Cloud Storage and Firestore metadata are backup/synchronization operations and cannot prevent the local image from being used in the PWA or reports.

Firebase Storage upload and download-URL generation are handled separately with retries. A transient `storage/object-not-found` while obtaining a download URL no longer discards a successful upload or the local image. Deterministic asset paths remain in use, so re-uploading an asset replaces the same cloud object.

Student photo, staff signature, new staff signature, and school logo uploads all use the same local-first transaction pattern.


## v38
Adds daily class attendance with Present/Absent/Late status, term summaries, automatic report-card attendance totals, Firestore synchronization, backup/restore support, and role-based class access.


## v38 — Staff & Student Attendance
Adds a Head Teacher-only Teacher Attendance panel under Attendance, with Present, Absent, Late, Excused, and On Leave statuses, local-first storage, Firestore synchronization, backup/restore support, and activity logging. Student attendance remains available to teachers and Head Teachers.


## v38.1 Attendance UI refinement
- Attendance Students/Teachers tabs now use theme-safe high-contrast active styling.
- Student attendance now shows Present, Late, Total, and Absent. Total = Present + Late.
- Teacher attendance now shows Present, Late, Total, Absent, Excused, and On Leave. Total = Present + Late.
- Student report-card attendance continues to use Total attendance days, so Late counts as an attended day.


## v38.2 - Attendance ratios

Student Attendance now displays an Attendance Ratio for each pupil and an Average Pupil Attendance Ratio pill.
Teacher Attendance now displays an Attendance Ratio for each teacher and an Average Teacher Attendance Ratio pill.

Ratio calculation:
- Pupils: `(Present + Late) / (Present + Late + Absent) × 100`.
- Teachers: `(Present + Late) / (Present + Late + Absent) × 100`.
- Teacher Excused and On Leave days are excluded from the ratio denominator because they are not counted as absence.
- The average pill is the arithmetic mean of the individual ratios with a valid denominator.


## v38.3 School Calendar + Correct Times Open
- Added term opening and closing dates in Setup.
- Added Attendance > Calendar for Holidays and Midterm.
- Times Open counts weekdays inside the term, excluding Holiday and Midterm days.
- Student and teacher attendance ratios now use Times Open as denominator.
- Attendance cannot be recorded on Holiday or Midterm days.
- Calendar syncs to Firestore `schools/{schoolId}/schoolCalendar`.
- Backup and restore includes school calendar.


## v38.4 Attendance correction
- Restored the teacher-staff filter used by Teacher Attendance.
- Setup now reloads saved Term Opens and Term Closes values correctly.
- Legacy `termStartDate` / `termEndDate` values are accepted when present.
- Student and teacher ratios use calculated Times Open.
- Teacher Excused and On Leave days are excluded from the individual ratio denominator.
- Service-worker cache version bumped to force the corrected attendance code to load.


## v38.4 Attendance Summary / Report
Adds an Attendance Summary tab with Times Open, holiday and midterm counts, class pupil attendance, teacher attendance, average attendance ratios, calendar exceptions, and a print-ready Attendance Summary Report.


v38.5 - Attendance Summary Print/PDF fix:
- Print Attendance Report no longer uses window.open(), avoiding about:blank failures on mobile browsers.
- Added direct PDF export using jsPDF and html2canvas.
- Updated service-worker cache version.


## v38.5 UI/PDF updates
- Renamed Summary actions to Print Report and Download Report.
- Attendance tabs wrap on small screens so Summary is fully accessible without horizontal swiping.
- Replaced HTML-based PDF rendering with a reliable native jsPDF text/table renderer.


## v38.5 Attendance Dashboard + Completion Monitoring
- Attendance Dashboard on Summary tab.
- Term Times Open and attendance completion metrics.
- Monitoring date selector.
- Daily class completion: complete, partial, not recorded.
- Daily teacher completion for Head Teacher.
- Term-level fully recorded student and teacher attendance days.
- Weekend and out-of-term dates are not treated as attendance days.
- Existing Print Report and Download Report are retained.


## v38.7 Attendance Analysis
- Pupil and teacher attendance analysis.
- Average ratio, below-75% alerts, late and absent totals.
- Current and longest absence streaks.
- Pupil class filter and name search.
- Head Teacher teacher-analysis view includes Head Teacher as teaching staff.
- Holidays, midterm and weekends excluded from Times Open.
