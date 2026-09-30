
> test:final
> node scripts/final-regression.cjs

Syntax checks passed: 72 JavaScript files / inline scripts.
TAP version 13
# Subtest: verified test payments credit only the test balance, once
ok 1 - verified test payments credit only the test balance, once
  ---
  duration_ms: 7.223772
  type: 'test'
  ...
# Subtest: reject mismatched payment {"amount":100}
ok 2 - reject mismatched payment {"amount":100}
  ---
  duration_ms: 2.48054
  type: 'test'
  ...
# Subtest: reject mismatched payment {"currency":"NGN"}
ok 3 - reject mismatched payment {"currency":"NGN"}
  ---
  duration_ms: 1.367633
  type: 'test'
  ...
# Subtest: reject mismatched payment {"domain":"live"}
ok 4 - reject mismatched payment {"domain":"live"}
  ---
  duration_ms: 1.258171
  type: 'test'
  ...
# Subtest: reject mismatched payment {"reference":"other"}
ok 5 - reject mismatched payment {"reference":"other"}
  ---
  duration_ms: 2.490085
  type: 'test'
  ...
# Subtest: reject mismatched payment {"status":"failed"}
ok 6 - reject mismatched payment {"status":"failed"}
  ---
  duration_ms: 1.223823
  type: 'test'
  ...
# Subtest: reject mismatched payment {"metadata":{"schoolId":"other","uid":"head"}}
ok 7 - reject mismatched payment {"metadata":{"schoolId":"other","uid":"head"}}
  ---
  duration_ms: 1.153071
  type: 'test'
  ...
# Subtest: live keys and live-credit deductions remain disabled
ok 8 - live keys and live-credit deductions remain disabled
  ---
  duration_ms: 2.270589
  type: 'test'
  ...
# Subtest: another account cannot verify the purchase
ok 9 - another account cannot verify the purchase
  ---
  duration_ms: 1.669235
  type: 'test'
  ...
# Subtest: public checkout endpoints reject requests without Firebase sign-in
ok 10 - public checkout endpoints reject requests without Firebase sign-in
  ---
  duration_ms: 2.188902
  type: 'test'
  ...
# Subtest: signed-in teachers cannot initialize or verify purchases
ok 11 - signed-in teachers cannot initialize or verify purchases
  ---
  duration_ms: 1.780789
  type: 'test'
  ...
# Subtest: single and batch deductions use only test credits and retries are idempotent
ok 12 - single and batch deductions use only test credits and retries are idempotent
  ---
  duration_ms: 3.72722
  type: 'test'
  ...
# Subtest: insufficient test balance never falls back to live credits
ok 13 - insufficient test balance never falls back to live credits
  ---
  duration_ms: 1.534731
  type: 'test'
  ...
# Subtest: deductions validate identity, active role, count, mode and request ID
ok 14 - deductions validate identity, active role, count, mode and request ID
  ---
  duration_ms: 1.528701
  type: 'test'
  ...
# Subtest: active teachers can consume test credits
ok 15 - active teachers can consume test credits
  ---
  duration_ms: 1.529205
  type: 'test'
  ...
# Subtest: lifetime verification is school-owned, idempotent and does not mint credits
ok 16 - lifetime verification is school-owned, idempotent and does not mint credits
  ---
  duration_ms: 2.173922
  type: 'test'
  ...
# Subtest: foreign-school and live licences do not grant test report access
ok 17 - foreign-school and live licences do not grant test report access
  ---
  duration_ms: 1.260773
  type: 'test'
  ...
# Subtest: attendance verification unlocks only the purchased term and preserves balances
ok 18 - attendance verification unlocks only the purchased term and preserves balances
  ---
  duration_ms: 1.415164
  type: 'test'
  ...
# Subtest: attendance initialization requires a saved term and rejects duplicate unlocks
ok 19 - attendance initialization requires a saved term and rejects duplicate unlocks
  ---
  duration_ms: 1.40827
  type: 'test'
  ...
# Subtest: checkout stays locked until cancellation and retains a recoverable reference
ok 20 - checkout stays locked until cancellation and retains a recoverable reference
  ---
  duration_ms: 6.67426
  type: 'test'
  ...
# Subtest: reusable categories create fee items for one class, multiple classes, all classes and one pupil
ok 21 - reusable categories create fee items for one class, multiple classes, all classes and one pupil
  ---
  duration_ms: 9.211509
  type: 'test'
  ...
# Subtest: fee item edits are revision-safe, preserve discounts and cannot reduce below payments or cancel paid charges
ok 22 - fee item edits are revision-safe, preserve discounts and cannot reduce below payments or cancel paid charges
  ---
  duration_ms: 3.556311
  type: 'test'
  ...
# Subtest: oldest-first and manual payment allocations are exact, shown on receipts and reversible
ok 23 - oldest-first and manual payment allocations are exact, shown on receipts and reversible
  ---
  duration_ms: 14.419314
  type: 'test'
  ...
# Subtest: legacy v40 accounts migrate without deletion and keep report balances exact
ok 24 - legacy v40 accounts migrate without deletion and keep report balances exact
  ---
  duration_ms: 4.411273
  type: 'test'
  ...
# Subtest: new adjustments and payments on migrated charges remain mirrored to the v40 account
ok 25 - new adjustments and payments on migrated charges remain mirrored to the v40 account
  ---
  duration_ms: 1.095698
  type: 'test'
  ...
# Subtest: arrears are grouped by category and term with pupil due, paid and balance totals
ok 26 - arrears are grouped by category and term with pupil due, paid and balance totals
  ---
  duration_ms: 1.720685
  type: 'test'
  ...
# Subtest: test cleanup removes only flagged test fee data and leaves production records untouched
ok 27 - test cleanup removes only flagged test fee data and leaves production records untouched
  ---
  duration_ms: 2.101976
  type: 'test'
  ...
# Subtest: all v2 financial mutations require the active Head Teacher
ok 28 - all v2 financial mutations require the active Head Teacher
  ---
  duration_ms: 0.717133
  type: 'test'
  ...
# Subtest: class fees are applied once and individual discounts stay intact
ok 29 - class fees are applied once and individual discounts stay intact
  ---
  duration_ms: 12.443955
  type: 'test'
  ...
# Subtest: payment retries issue one receipt and void restores the balance once
ok 30 - payment retries issue one receipt and void restores the balance once
  ---
  duration_ms: 6.967497
  type: 'test'
  ...
# Subtest: fees require an active head and reject invalid amounts without writes
ok 31 - fees require an active head and reject invalid amounts without writes
  ---
  duration_ms: 3.54256
  type: 'test'
  ...
# Subtest: old term balances survive new term charges and pupil deletion
ok 32 - old term balances survive new term charges and pupil deletion
  ---
  duration_ms: 1.136983
  type: 'test'
  ...
# Subtest: failed transaction does not issue a receipt or alter balances
ok 33 - failed transaction does not issue a receipt or alter balances
  ---
  duration_ms: 1.127486
  type: 'test'
  ...
# Subtest: fee editing and cancellation preserve paid money and reject stale changes
ok 34 - fee editing and cancellation preserve paid money and reject stale changes
  ---
  duration_ms: 2.160659
  type: 'test'
  ...
# Subtest: class edits preserve discounts and cancellation is atomic when one pupil has paid
ok 35 - class edits preserve discounts and cancellation is atomic when one pupil has paid
  ---
  duration_ms: 3.008108
  type: 'test'
  ...
# Subtest: new year payments clear oldest debt without duplicating charges and void reverses allocations
ok 36 - new year payments clear oldest debt without duplicating charges and void reverses allocations
  ---
  duration_ms: 12.802105
  type: 'test'
  ...
# Subtest: report balances include arrears and payments, exclude future terms and unrelated pupils
ok 37 - report balances include arrears and payments, exclude future terms and unrelated pupils
  ---
  duration_ms: 2.778596
  type: 'test'
  ...
# Subtest: managed zero balance overrides manual fees and cancellations remain visible
ok 38 - managed zero balance overrides manual fees and cancellations remain visible
  ---
  duration_ms: 3.675603
  type: 'test'
  ...
# Subtest: premium and batch reports are paid; Black & White singles request the server allowance
ok 39 - premium and batch reports are paid; Black & White singles request the server allowance
  ---
  duration_ms: 9.081998
  type: 'test'
  ...
# Subtest: failDraw does not deduct or download
ok 40 - failDraw does not deduct or download
  ---
  duration_ms: 2.708473
  type: 'test'
  ...
# Subtest: failOutput does not deduct or download
ok 41 - failOutput does not deduct or download
  ---
  duration_ms: 2.424546
  type: 'test'
  ...
# Subtest: insufficient balance blocks generation; overlapping clicks only deduct once
ok 42 - insufficient balance blocks generation; overlapping clicks only deduct once
  ---
  duration_ms: 3.938635
  type: 'test'
  ...
# Subtest: transient deduction retries reuse the request ID and update only the test balance
ok 43 - transient deduction retries reuse the request ID and update only the test balance
  ---
  duration_ms: 2.593085
  type: 'test'
  ...
# Subtest: guest generation stops after ten reports without using school credits
ok 44 - guest generation stops after ten reports without using school credits
  ---
  duration_ms: 4.690498
  type: 'test'
  ...
# Subtest: single and batch report renderers receive ledger balances instead of stale manual fees
ok 45 - single and batch report renderers receive ledger balances instead of stale manual fees
  ---
  duration_ms: 3.311472
  type: 'test'
  ...
# Subtest: unavailable confirmed fee balances block printing before any credit deduction
ok 46 - unavailable confirmed fee balances block printing before any credit deduction
  ---
  duration_ms: 2.271768
  type: 'test'
  ...
# Subtest: leaf merge clears a score without losing another device subject edit
ok 47 - leaf merge clears a score without losing another device subject edit
  ---
  duration_ms: 2.540974
  type: 'test'
  ...
# Subtest: teacher writes require active class and subject permissions
ok 48 - teacher writes require active class and subject permissions
  ---
  duration_ms: 2.95988
  type: 'test'
  ...
# Subtest: server conflicts and deletion markers reject stale edits
ok 49 - server conflicts and deletion markers reject stale edits
  ---
  duration_ms: 0.549198
  type: 'test'
  ...
# Subtest: staff response excludes personnel identifiers and bank details
ok 50 - staff response excludes personnel identifiers and bank details
  ---
  duration_ms: 0.401478
  type: 'test'
  ...
# Subtest: rollover commits archive and roster together and retry is idempotent
ok 51 - rollover commits archive and roster together and retry is idempotent
  ---
  duration_ms: 3.630444
  type: 'test'
  ...
# Subtest: oversized rollover and foreign-school restore fail before any writes
ok 52 - oversized rollover and foreign-school restore fail before any writes
  ---
  duration_ms: 9.128552
  type: 'test'
  ...
# Subtest: UTF-8 archives preserve non-ASCII characters at byte boundaries
ok 53 - UTF-8 archives preserve non-ASCII characters at byte boundaries
  ---
  duration_ms: 14.89555
  type: 'test'
  ...
# Subtest: fresh entry after a clear is accepted but older devices stay blocked
ok 54 - fresh entry after a clear is accepted but older devices stay blocked
  ---
  duration_ms: 1.040336
  type: 'test'
  ...
# Subtest: attendance always retains its queryable class and deleted classes reject edits
ok 55 - attendance always retains its queryable class and deleted classes reject edits
  ---
  duration_ms: 1.384412
  type: 'test'
  ...
# Subtest: legacy migration preserves newer and explicitly deleted records
ok 56 - legacy migration preserves newer and explicitly deleted records
  ---
  duration_ms: 1.154023
  type: 'test'
  ...
# Subtest: deleting a student with grades syncs and preserves other pupils and concurrent edits
ok 57 - deleting a student with grades syncs and preserves other pupils and concurrent edits
  ---
  duration_ms: 0.789847
  type: 'test'
  ...
# Subtest: grade container deletion retains subject permissions and is atomic
ok 58 - grade container deletion retains subject permissions and is atomic
  ---
  duration_ms: 0.626341
  type: 'test'
  ...
# Subtest: student grade deletion rejects concurrent changes and malformed replacements
ok 59 - student grade deletion rejects concurrent changes and malformed replacements
  ---
  duration_ms: 0.78026
  type: 'test'
  ...
# Subtest: teachers can finish all-subject cleanup only for deleted pupils in their assigned class
ok 60 - teachers can finish all-subject cleanup only for deleted pupils in their assigned class
  ---
  duration_ms: 0.942262
  type: 'test'
  ...
# Subtest: object key order does not produce false conflicts when deleting grade containers
ok 61 - object key order does not produce false conflicts when deleting grade containers
  ---
  duration_ms: 0.175007
  type: 'test'
  ...
# Subtest: confirmed pupil deletion resolves stale grades cleanup without changing surviving pupils
ok 62 - confirmed pupil deletion resolves stale grades cleanup without changing surviving pupils
  ---
  duration_ms: 0.463504
  type: 'test'
  ...
# Subtest: confirmed pupil deletion resolves stale remarks cleanup without changing surviving pupils
ok 63 - confirmed pupil deletion resolves stale remarks cleanup without changing surviving pupils
  ---
  duration_ms: 0.190147
  type: 'test'
  ...
# Subtest: confirmed pupil deletion resolves stale attendance cleanup without changing surviving pupils
ok 64 - confirmed pupil deletion resolves stale attendance cleanup without changing surviving pupils
  ---
  duration_ms: 0.50946
  type: 'test'
  ...
# Subtest: deletion cleanup does not hide surviving-pupil conflicts or delete a restored pupil
ok 65 - deletion cleanup does not hide surviving-pupil conflicts or delete a restored pupil
  ---
  duration_ms: 0.789204
  type: 'test'
  ...
# Subtest: approved teacher sees only their linked personal record and updates allowed fields
ok 66 - approved teacher sees only their linked personal record and updates allowed fields
  ---
  duration_ms: 0.910944
  type: 'test'
  ...
# Subtest: personal details reject disabled, unlinked, foreign and mismatched teacher accounts
ok 67 - personal details reject disabled, unlinked, foreign and mismatched teacher accounts
  ---
  duration_ms: 1.037516
  type: 'test'
  ...
# Subtest: personal details cannot change school authority, other staff or invalid values
ok 68 - personal details cannot change school authority, other staff or invalid values
  ---
  duration_ms: 1.474252
  type: 'test'
  ...
# Subtest: personal changes preserve concurrent school changes and reject same-field conflicts
ok 69 - personal changes preserve concurrent school changes and reject same-field conflicts
  ---
  duration_ms: 0.457312
  type: 'test'
  ...
# Subtest: head teacher can atomically delete a subject with hidden historical grade references
ok 70 - head teacher can atomically delete a subject with hidden historical grade references
  ---
  duration_ms: 4.817694
  type: 'test'
  ...
# Subtest: profile relinking during editing rejects the old record and reads the new link
ok 71 - profile relinking during editing rejects the old record and reads the new link
  ---
  duration_ms: 0.4066
  type: 'test'
  ...
# Subtest: profile retry is idempotent and does not change account email or staff linkage
ok 72 - profile retry is idempotent and does not change account email or staff linkage
  ---
  duration_ms: 0.509037
  type: 'test'
  ...
# Subtest: profile validation and commit failure never save a partial update
ok 73 - profile validation and commit failure never save a partial update
  ---
  duration_ms: 0.816334
  type: 'test'
  ...
# Subtest: pending and rejected accounts cannot access My Details
ok 74 - pending and rejected accounts cannot access My Details
  ---
  duration_ms: 0.788391
  type: 'test'
  ...
# Subtest: Setup partial updates preserve cloud fields and retain a recovery copy
ok 75 - Setup partial updates preserve cloud fields and retain a recovery copy
  ---
  duration_ms: 0.635777
  type: 'test'
  ...
# Subtest: Setup rejects stale defaults, destructive blanks and unauthorized changes
ok 76 - Setup rejects stale defaults, destructive blanks and unauthorized changes
  ---
  duration_ms: 1.286957
  type: 'test'
  ...
# Subtest: server preserves marks but rejects stale writes to a school strike date
ok 77 - server preserves marks but rejects stale writes to a school strike date
  ---
  duration_ms: 0.529441
  type: 'test'
  ...
# Subtest: pending approval, unlink, relink, disable and reactivation retain exactly one Staff record
ok 78 - pending approval, unlink, relink, disable and reactivation retain exactly one Staff record
  ---
  duration_ms: 9.478301
  type: 'test'
  ...
# Subtest: email matching prefers existing staff; similar names require explicit review and cannot steal a link
ok 79 - email matching prefers existing staff; similar names require explicit review and cannot steal a link
  ---
  duration_ms: 3.529639
  type: 'test'
  ...
# Subtest: removal clears membership atomically and preserves school history; rejoin relinks
ok 80 - removal clears membership atomically and preserves school history; rejoin relinks
  ---
  duration_ms: 4.634624
  type: 'test'
  ...
# Subtest: teacher Home counts unique active peer accounts sharing an assigned class
ok 81 - teacher Home counts unique active peer accounts sharing an assigned class
  ---
  duration_ms: 1.141504
  type: 'test'
  ...
# Subtest: one click adds 30 students, preserving IDs and clearing the input
ok 82 - one click adds 30 students, preserving IDs and clearing the input
  ---
  duration_ms: 5.541064
  type: 'test'
  ...
# Subtest: staff bulk add handles 65 records and defaults their role to Teacher
ok 83 - staff bulk add handles 65 records and defaults their role to Teacher
  ---
  duration_ms: 3.764508
  type: 'test'
  ...
# Subtest: validates the entire list before saving missing or repeated Staff IDs
ok 84 - validates the entire list before saving missing or repeated Staff IDs
  ---
  duration_ms: 2.360422
  type: 'test'
  ...
# Subtest: partial failure retains only unsaved lines, and retry avoids duplicates
ok 85 - partial failure retains only unsaved lines, and retry avoids duplicates
  ---
  duration_ms: 3.528141
  type: 'test'
  ...
# Subtest: duplicate clicks cannot start another save, and session changes stop further writes
ok 86 - duplicate clicks cannot start another save, and session changes stop further writes
  ---
  duration_ms: 3.026209
  type: 'test'
  ...
# Subtest: existing Student IDs are rejected without saving any part of the list
ok 87 - existing Student IDs are rejected without saving any part of the list
  ---
  duration_ms: 1.668924
  type: 'test'
  ...
# Billing allowance checks passed: 10 shared free reports, 11th charged, retries, batches, insufficient balance, term/year reset, old-term protection and authentication.
# Subtest: tests/bw-allowance.test.cjs
ok 9 - tests/bw-allowance.test.cjs
  ---
  duration_ms: 40.70832
  type: 'test'
  ...
# Subtest: single and bulk student deletion clean grades, both attendance formats and remarks
ok 89 - single and bulk student deletion clean grades, both attendance formats and remarks
  ---
  duration_ms: 6.142617
  type: 'test'
  ...
# Subtest: class deletion remains protected while subject deletion requires an explicit score-cascade confirmation
ok 90 - class deletion remains protected while subject deletion requires an explicit score-cascade confirmation
  ---
  duration_ms: 6.878701
  type: 'test'
  ...
# Subtest: cloud-only dependencies block deletion even when local data looks empty
ok 91 - cloud-only dependencies block deletion even when local data looks empty
  ---
  duration_ms: 1.362908
  type: 'test'
  ...
# Subtest: permission denial or cloud failure preserves all local records
ok 92 - permission denial or cloud failure preserves all local records
  ---
  duration_ms: 5.636569
  type: 'test'
  ...
# Subtest: staff deletion clears assignments, retains history and explains account access
ok 93 - staff deletion clears assignments, retains history and explains account access
  ---
  duration_ms: 3.94707
  type: 'test'
  ...
# Subtest: oversized and offline deletes perform no writes
ok 94 - oversized and offline deletes perform no writes
  ---
  duration_ms: 1.903683
  type: 'test'
  ...
# Subtest: every individual delete button uses the shared deletion handler
ok 95 - every individual delete button uses the shared deletion handler
  ---
  duration_ms: 3.95656
  type: 'test'
  ...
# Subtest: both assigned teachers and the Head Teacher resolve the designated signer
ok 96 - both assigned teachers and the Head Teacher resolve the designated signer
  ---
  duration_ms: 7.783412
  type: 'test'
  ...
# Subtest: missing or deleted designated staff never falls back to the signed-in teacher
ok 97 - missing or deleted designated staff never falls back to the signed-in teacher
  ---
  duration_ms: 7.795813
  type: 'test'
  ...
# Subtest: offline fee saves retain identities until connection and serialize overlapping flushes
ok 98 - offline fee saves retain identities until connection and serialize overlapping flushes
  ---
  duration_ms: 6.574071
  type: 'test'
  ...
# Subtest: network failure retains original queued request and rejected entry blocks later saves for review
ok 99 - network failure retains original queued request and rejected entry blocks later saves for review
  ---
  duration_ms: 2.713497
  type: 'test'
  ...
# Subtest: Head Teacher sees all classes, active students and subjects
ok 100 - Head Teacher sees all classes, active students and subjects
  ---
  duration_ms: 4.555936
  type: 'test'
  ...
# Subtest: Teacher reads only assigned classes, students and subjects
ok 101 - Teacher reads only assigned classes, students and subjects
  ---
  duration_ms: 2.007905
  type: 'test'
  ...
# Subtest: Missing assignments and inactive identity yield no accessible classes
ok 102 - Missing assignments and inactive identity yield no accessible classes
  ---
  duration_ms: 1.420996
  type: 'test'
  ...
# Subtest: Head Teacher navigation: home
ok 103 - Head Teacher navigation: home
  ---
  duration_ms: 2.123592
  type: 'test'
  ...
# Subtest: Head Teacher navigation: setup
ok 104 - Head Teacher navigation: setup
  ---
  duration_ms: 3.052196
  type: 'test'
  ...
# Subtest: Head Teacher navigation: staff
ok 105 - Head Teacher navigation: staff
  ---
  duration_ms: 1.740534
  type: 'test'
  ...
# Subtest: Head Teacher navigation: classes
ok 106 - Head Teacher navigation: classes
  ---
  duration_ms: 2.128493
  type: 'test'
  ...
# Subtest: Head Teacher navigation: students
ok 107 - Head Teacher navigation: students
  ---
  duration_ms: 1.696525
  type: 'test'
  ...
# Subtest: Head Teacher navigation: subjects
ok 108 - Head Teacher navigation: subjects
  ---
  duration_ms: 1.737229
  type: 'test'
  ...
# Subtest: Head Teacher navigation: attendance
ok 109 - Head Teacher navigation: attendance
  ---
  duration_ms: 1.637761
  type: 'test'
  ...
# Subtest: Head Teacher navigation: grades
ok 110 - Head Teacher navigation: grades
  ---
  duration_ms: 1.108876
  type: 'test'
  ...
# Subtest: Head Teacher navigation: remarks
ok 111 - Head Teacher navigation: remarks
  ---
  duration_ms: 1.227202
  type: 'test'
  ...
# Subtest: Head Teacher navigation: reports
ok 112 - Head Teacher navigation: reports
  ---
  duration_ms: 1.40727
  type: 'test'
  ...
# Subtest: Head Teacher navigation: billing
ok 113 - Head Teacher navigation: billing
  ---
  duration_ms: 1.401548
  type: 'test'
  ...
# Subtest: Head Teacher navigation: history
ok 114 - Head Teacher navigation: history
  ---
  duration_ms: 0.960458
  type: 'test'
  ...
# Subtest: Head Teacher navigation: manage-teachers
ok 115 - Head Teacher navigation: manage-teachers
  ---
  duration_ms: 1.071462
  type: 'test'
  ...
# Subtest: Head Teacher navigation: activity
ok 116 - Head Teacher navigation: activity
  ---
  duration_ms: 1.032129
  type: 'test'
  ...
# Subtest: Teacher direct navigation blocks setup
ok 117 - Teacher direct navigation blocks setup
  ---
  duration_ms: 0.985895
  type: 'test'
  ...
# Subtest: Teacher direct navigation blocks staff
ok 118 - Teacher direct navigation blocks staff
  ---
  duration_ms: 1.091703
  type: 'test'
  ...
# Subtest: Teacher direct navigation blocks classes
ok 119 - Teacher direct navigation blocks classes
  ---
  duration_ms: 1.377569
  type: 'test'
  ...
# Subtest: Teacher direct navigation blocks subjects
ok 120 - Teacher direct navigation blocks subjects
  ---
  duration_ms: 0.772779
  type: 'test'
  ...
# Subtest: Teacher direct navigation blocks billing
ok 121 - Teacher direct navigation blocks billing
  ---
  duration_ms: 0.625277
  type: 'test'
  ...
# Subtest: Teacher direct navigation blocks manage-teachers
ok 122 - Teacher direct navigation blocks manage-teachers
  ---
  duration_ms: 0.613066
  type: 'test'
  ...
# Subtest: Teacher navigation permits home
ok 123 - Teacher navigation permits home
  ---
  duration_ms: 0.653054
  type: 'test'
  ...
# Subtest: Teacher navigation permits students
ok 124 - Teacher navigation permits students
  ---
  duration_ms: 0.986574
  type: 'test'
  ...
# Subtest: Teacher navigation permits attendance
ok 125 - Teacher navigation permits attendance
  ---
  duration_ms: 0.621272
  type: 'test'
  ...
# Subtest: Teacher navigation permits grades
ok 126 - Teacher navigation permits grades
  ---
  duration_ms: 1.434822
  type: 'test'
  ...
# Subtest: Teacher navigation permits remarks
ok 127 - Teacher navigation permits remarks
  ---
  duration_ms: 1.062135
  type: 'test'
  ...
# Subtest: Teacher navigation permits reports
ok 128 - Teacher navigation permits reports
  ---
  duration_ms: 0.681201
  type: 'test'
  ...
# Subtest: Navigation cannot render unresolved identity or expose a pre-hydration report view
ok 129 - Navigation cannot render unresolved identity or expose a pre-hydration report view
  ---
  duration_ms: 0.950031
  type: 'test'
  ...
# Subtest: Report asset deadline returns a warning and clears its timer
ok 130 - Report asset deadline returns a warning and clears its timer
  ---
  duration_ms: 2.659024
  type: 'test'
  ...
# Subtest: Report assets prefer record then cache and diagnose missing offline photos
ok 131 - Report assets prefer record then cache and diagnose missing offline photos
  ---
  duration_ms: 1.230299
  type: 'test'
  ...
# Subtest: Report asset workers preserve order and respect concurrency
ok 132 - Report asset workers preserve order and respect concurrency
  ---
  duration_ms: 24.898824
  type: 'test'
  ...
# Subtest: Missing report assets warn before proceeding; complete assets need no confirmation
ok 133 - Missing report assets warn before proceeding; complete assets need no confirmation
  ---
  duration_ms: 8.401467
  type: 'test'
  ...
# Subtest: Report asset check denies unassigned class before reading records
ok 134 - Report asset check denies unassigned class before reading records
  ---
  duration_ms: 4.375871
  type: 'test'
  ...
# Subtest: Year-end parser rejects malformed, incomplete and foreign-school backups
ok 135 - Year-end parser rejects malformed, incomplete and foreign-school backups
  ---
  duration_ms: 1.333179
  type: 'test'
  ...
# Subtest: Rollover and restore stop immediately for unauthorized users
ok 136 - Rollover and restore stop immediately for unauthorized users
  ---
  duration_ms: 1.267223
  type: 'test'
  ...
# Subtest: Historical zero scores protect a subject while empty references do not
ok 137 - Historical zero scores protect a subject while empty references do not
  ---
  duration_ms: 1.801424
  type: 'test'
  ...
# Subtest: Light, dark and system themes update document, browser bar and accessible label
ok 138 - Light, dark and system themes update document, browser bar and accessible label
  ---
  duration_ms: 1.250504
  type: 'test'
  ...
# Subtest: Service worker bypasses writes, school data and untrusted external resources
ok 139 - Service worker bypasses writes, school data and untrusted external resources
  ---
  duration_ms: 1.251113
  type: 'test'
  ...
# Subtest: Service worker refreshes the shell online and serves cached navigation offline
ok 140 - Service worker refreshes the shell online and serves cached navigation offline
  ---
  duration_ms: 1.180497
  type: 'test'
  ...
# Subtest: Failed HTTP responses cannot replace a cached shell
ok 141 - Failed HTTP responses cannot replace a cached shell
  ---
  duration_ms: 0.826808
  type: 'test'
  ...
# Subtest: Update activation retains current and unrelated caches
ok 142 - Update activation retains current and unrelated caches
  ---
  duration_ms: 0.71996
  type: 'test'
  ...
# Subtest: Every shipped public asset matches its root counterpart byte for byte
ok 143 - Every shipped public asset matches its root counterpart byte for byte
  ---
  duration_ms: 4.445503
  type: 'test'
  ...
# Subtest: Every precached shell asset exists in the hosting directory
ok 144 - Every precached shell asset exists in the hosting directory
  ---
  duration_ms: 0.903039
  type: 'test'
  ...
# Subtest: Rollover makes no writes when unresolved
ok 145 - Rollover makes no writes when unresolved
  ---
  duration_ms: 1.38037
  type: 'test'
  ...
# Subtest: Rollover makes no writes when invalid year
ok 146 - Rollover makes no writes when invalid year
  ---
  duration_ms: 1.064131
  type: 'test'
  ...
# Subtest: Rollover makes no writes when stale year
ok 147 - Rollover makes no writes when stale year
  ---
  duration_ms: 1.082297
  type: 'test'
  ...
# Subtest: Rollover makes no writes when cancelled
ok 148 - Rollover makes no writes when cancelled
  ---
  duration_ms: 0.821808
  type: 'test'
  ...
# Subtest: Rollover makes no writes when hydrating
ok 149 - Rollover makes no writes when hydrating
  ---
  duration_ms: 0.907233
  type: 'test'
  ...
# Subtest: Emergency restore makes no data writes when hydrating
ok 150 - Emergency restore makes no data writes when hydrating
  ---
  duration_ms: 0.746155
  type: 'test'
  ...
# Subtest: Emergency restore makes no data writes when cancelled
ok 151 - Emergency restore makes no data writes when cancelled
  ---
  duration_ms: 0.728277
  type: 'test'
  ...
# Subtest: Emergency restore makes no data writes when snapshot failure
ok 152 - Emergency restore makes no data writes when snapshot failure
  ---
  duration_ms: 0.857751
  type: 'test'
  ...
# Subtest: Manage Teachers uses compact red Remove action
ok 153 - Manage Teachers uses compact red Remove action
  ---
  duration_ms: 2.067155
  type: 'test'
  ...
# Subtest: Arrears Management and Reminder Generator controls ship with responsive parent statement UI
ok 154 - Arrears Management and Reminder Generator controls ship with responsive parent statement UI
  ---
  duration_ms: 1.466742
  type: 'test'
  ...
# Subtest: arrears rows exclude settled, cancelled, future and test records by default
ok 155 - arrears rows exclude settled, cancelled, future and test records by default
  ---
  duration_ms: 3.795746
  type: 'test'
  ...
# Subtest: arrears filters cover class, category and guardian or phone search
ok 156 - arrears filters cover class, category and guardian or phone search
  ---
  duration_ms: 3.87412
  type: 'test'
  ...
# Subtest: statement buckets separate previous arrears, current balance and future charges
ok 157 - statement buckets separate previous arrears, current balance and future charges
  ---
  duration_ms: 10.815321
  type: 'test'
  ...
# Subtest: parent reminder text is personalized and Ghana local phones normalize for WhatsApp
ok 158 - parent reminder text is personalized and Ghana local phones normalize for WhatsApp
  ---
  duration_ms: 1.553958
  type: 'test'
  ...
# Subtest: parent statement rendering includes guardian contact and arrears/current summary
ok 159 - parent statement rendering includes guardian contact and arrears/current summary
  ---
  duration_ms: 0.196048
  type: 'test'
  ...
# Subtest: FIS financial dashboard and report filters are present and read-only
ok 160 - FIS financial dashboard and report filters are present and read-only
  ---
  duration_ms: 1.796409
  type: 'test'
  ...
# Subtest: financial summary handles discounts, additions, arrears and collection totals
ok 161 - financial summary handles discounts, additions, arrears and collection totals
  ---
  duration_ms: 2.751837
  type: 'test'
  ...
# Subtest: report filters separate production, test, class, category and balance status
ok 162 - report filters separate production, test, class, category and balance status
  ---
  duration_ms: 3.134825
  type: 'test'
  ...
# Subtest: payment method analytics count only allocations matching the filtered charges and ignore voids
ok 163 - payment method analytics count only allocations matching the filtered charges and ignore voids
  ---
  duration_ms: 1.831402
  type: 'test'
  ...
# Subtest: pupil statements include charge, payment, CSV and print controls with responsive styling
ok 164 - pupil statements include charge, payment, CSV and print controls with responsive styling
  ---
  duration_ms: 0.402687
  type: 'test'
  ...
# Subtest: CSV export protects spreadsheet formulas without converting numeric amounts to text
ok 165 - CSV export protects spreadsheet formulas without converting numeric amounts to text
  ---
  duration_ms: 2.755238
  type: 'test'
  ...
# Subtest: Reminder Generator gives visible action feedback without changing send semantics
ok 166 - Reminder Generator gives visible action feedback without changing send semantics
  ---
  duration_ms: 1.466167
  type: 'test'
  ...
# Subtest: all Fees and Receipts table wrappers scroll horizontally and pin their row label column
ok 167 - all Fees and Receipts table wrappers scroll horizontally and pin their row label column
  ---
  duration_ms: 0.416584
  type: 'test'
  ...
# Subtest: arrears table pins the pupil name beside its selection checkbox
ok 168 - arrears table pins the pupil name beside its selection checkbox
  ---
  duration_ms: 1.419977
  type: 'test'
  ...
# Subtest: receipt allocation table participates in mobile horizontal scrolling
ok 169 - receipt allocation table participates in mobile horizontal scrolling
  ---
  duration_ms: 0.586999
  type: 'test'
  ...
# Subtest: service worker cache is bumped for reminder feedback and table UX delivery
ok 170 - service worker cache is bumped for reminder feedback and table UX delivery
  ---
  duration_ms: 0.298526
  type: 'test'
  ...
# Subtest: FIS UI exposes categories, all fee scopes, manual allocation, arrears and test cleanup
ok 171 - FIS UI exposes categories, all fee scopes, manual allocation, arrears and test cleanup
  ---
  duration_ms: 1.572698
  type: 'test'
  ...
# Subtest: receipt UI renders allocation lines and retains void status
ok 172 - receipt UI renders allocation lines and retains void status
  ---
  duration_ms: 0.287083
  type: 'test'
  ...
# Subtest: client balance helpers keep cancelled charges at zero and calculate due paid balance separately
ok 173 - client balance helpers keep cancelled charges at zero and calculate due paid balance separately
  ---
  duration_ms: 2.834817
  type: 'test'
  ...
# Subtest: Firestore denies direct access to every FIS financial collection
ok 174 - Firestore denies direct access to every FIS financial collection
  ---
  duration_ms: 0.509494
  type: 'test'
  ...
# Subtest: FIS mutations refresh confirmed data in place without showing the full loading screen
ok 175 - FIS mutations refresh confirmed data in place without showing the full loading screen
  ---
  duration_ms: 0.340716
  type: 'test'
  ...
# Subtest: opening Fees & Receipts reuses the rendered view and uses confirmed cache before network refresh
ok 176 - opening Fees & Receipts reuses the rendered view and uses confirmed cache before network refresh
  ---
  duration_ms: 3.744646
  type: 'test'
  ...
# Subtest: old v40 fee cache is discarded so Chrome can fetch the upgraded FIS ledger
ok 177 - old v40 fee cache is discarded so Chrome can fetch the upgraded FIS ledger
  ---
  duration_ms: 0.893694
  type: 'test'
  ...
# Subtest: FIS spacing and controls follow the shared SchoolHub screen rhythm on desktop and mobile
ok 178 - FIS spacing and controls follow the shared SchoolHub screen rhythm on desktop and mobile
  ---
  duration_ms: 0.221012
  type: 'test'
  ...
# Subtest: service worker cache is bumped for the FIS build and caches fees.js
ok 179 - service worker cache is bumped for the FIS build and caches fees.js
  ---
  duration_ms: 0.40944
  type: 'test'
  ...
# Guest trial checks passed: expiry boundary, resume, permissions, themes, billing restrictions, data preservation and migration.
# Subtest: tests/guest-trial.test.cjs
ok 18 - tests/guest-trial.test.cjs
  ---
  duration_ms: 61.197094
  type: 'test'
  ...
# hydration deadline + report asset check regression: PASS
# Subtest: tests/hydration-report-assets-stability.test.cjs
ok 19 - tests/hydration-report-assets-stability.test.cjs
  ---
  duration_ms: 41.130954
  type: 'test'
  ...
# Subtest: service worker registration manages lifecycle, update checks and diagnostics
ok 182 - service worker registration manages lifecycle, update checks and diagnostics
  ---
  duration_ms: 2.381983
  type: 'test'
  ...
# Subtest: native Background Sync reuses existing SchoolHub queues and safeguards
ok 183 - native Background Sync reuses existing SchoolHub queues and safeguards
  ---
  duration_ms: 0.987751
  type: 'test'
  ...
# Subtest: background sync remains progressive enhancement, not a replacement for offline recovery
ok 184 - background sync remains progressive enhancement, not a replacement for offline recovery
  ---
  duration_ms: 1.386723
  type: 'test'
  ...
# Subtest: service worker sync event waits for a client acknowledgement
ok 185 - service worker sync event waits for a client acknowledgement
  ---
  duration_ms: 8.260753
  type: 'test'
  ...
# Subtest: service worker leaves unrelated sync tags alone
ok 186 - service worker leaves unrelated sync tags alone
  ---
  duration_ms: 1.652372
  type: 'test'
  ...
# Registration navigation passed: Home is reachable before the initial cloud upload completes.
# Subtest: tests/registration-navigation.test.cjs
ok 21 - tests/registration-navigation.test.cjs
  ---
  duration_ms: 50.116254
  type: 'test'
  ...
# Report generation failed: Error: PDF library unavailable
#     at f.ctx.generateSinglePDF (/mnt/data/reminder_action_table_patch_work/tests/report-buttons.test.cjs:34:61)
#     at evalmachine.<anonymous>:31:13
#     at runReportAction (evalmachine.<anonymous>:5:15)
#     at Object.click (evalmachine.<anonymous>:24:41)
#     at TestContext.<anonymous> (/mnt/data/reminder_action_table_patch_work/tests/report-buttons.test.cjs:35:51)
#     at Test.runInAsyncScope (node:async_hooks:214:14)
#     at Test.run (node:internal/test_runner/test:1047:25)
#     at Test.processPendingSubtests (node:internal/test_runner/test:744:18)
#     at Test.postRun (node:internal/test_runner/test:1173:19)
#     at Test.run (node:internal/test_runner/test:1101:12)
# Subtest: individual report button passes the current academic year and reaches PDF generation
ok 188 - individual report button passes the current academic year and reaches PDF generation
  ---
  duration_ms: 5.868739
  type: 'test'
  ...
# Subtest: class batch button passes the current academic year and reaches PDF generation
ok 189 - class batch button passes the current academic year and reaches PDF generation
  ---
  duration_ms: 3.201173
  type: 'test'
  ...
# Subtest: report failures are visible and the button becomes usable again
ok 190 - report failures are visible and the button becomes usable again
  ---
  duration_ms: 6.643201
  type: 'test'
  ...
# Subtest: report button displays progress until generation finishes
ok 191 - report button displays progress until generation finishes
  ---
  duration_ms: 2.285753
  type: 'test'
  ...
# Subtest: missing PDF library produces an actionable error
ok 192 - missing PDF library produces an actionable error
  ---
  duration_ms: 2.907826
  type: 'test'
  ...
# Subtest: cloud staff without embedded IDs survive merging as distinct records
ok 193 - cloud staff without embedded IDs survive merging as distinct records
  ---
  duration_ms: 2.863268
  type: 'test'
  ...
# Subtest: partial staff sync never deletes cloud staff, including an empty local list
ok 194 - partial staff sync never deletes cloud staff, including an empty local list
  ---
  duration_ms: 2.362015
  type: 'test'
  ...
# Subtest: staff push opts out of deletion by omission
ok 195 - staff push opts out of deletion by omission
  ---
  duration_ms: 0.638148
  type: 'test'
  ...
# Subtest: updates by Staff ID and preserves blanks, signatures and linked accounts
ok 196 - updates by Staff ID and preserves blanks, signatures and linked accounts
  ---
  duration_ms: 2.975697
  type: 'test'
  ...
# Subtest: new rows receive new internal IDs; unknown identity columns are ignored
ok 197 - new rows receive new internal IDs; unknown identity columns are ignored
  ---
  duration_ms: 0.65618
  type: 'test'
  ...
# Subtest: duplicates, missing required values and conflicting headers block the import
ok 198 - duplicates, missing required values and conflicting headers block the import
  ---
  duration_ms: 2.257574
  type: 'test'
  ...
# Subtest: validates real dates and select fields without deleting records
ok 199 - validates real dates and select fields without deleting records
  ---
  duration_ms: 1.259928
  type: 'test'
  ...
# Subtest: exported schema can be imported with every personnel field intact
ok 200 - exported schema can be imported with every personnel field intact
  ---
  duration_ms: 0.983439
  type: 'test'
  ...
# subject delete empty-reference regression: PASS
# Subtest: tests/subject-delete-empty-ref.test.cjs
ok 25 - tests/subject-delete-empty-ref.test.cjs
  ---
  duration_ms: 52.545455
  type: 'test'
  ...
# subject/report/cache regression: PASS
# Subtest: tests/subject-report-cache-fix.test.cjs
ok 26 - tests/subject-report-cache-fix.test.cjs
  ---
  duration_ms: 38.15985
  type: 'test'
  ...
# Sync Center/About consistency regression: PASS
# Subtest: tests/sync-about-consistency.test.cjs
ok 27 - tests/sync-about-consistency.test.cjs
  ---
  duration_ms: 57.993313
  type: 'test'
  ...
# Subtest: interrupted local write replays both its data and sync queue on restart
ok 204 - interrupted local write replays both its data and sync queue on restart
  ---
  duration_ms: 5.376747
  type: 'test'
  ...
# Subtest: malformed pending journal does not crash startup or allow subsequent overwrite
ok 205 - malformed pending journal does not crash startup or allow subsequent overwrite
  ---
  duration_ms: 1.420389
  type: 'test'
  ...
# Subtest: a partial service-worker install does not activate the new cache
ok 206 - a partial service-worker install does not activate the new cache
  ---
  duration_ms: 3.771844
  type: 'test'
  ...
# Subtest: header status distinguishes clean, sending, failed and offline records
ok 207 - header status distinguishes clean, sending, failed and offline records
  ---
  duration_ms: 2.38206
  type: 'test'
  ...
# Subtest: status does not claim up to date while account data is loading
ok 208 - status does not claim up to date while account data is loading
  ---
  duration_ms: 0.801246
  type: 'test'
  ...
# teacher mobile/profile/sync regression: PASS
# Subtest: tests/teacher-mobile-sync-ui.test.cjs
ok 30 - tests/teacher-mobile-sync-ui.test.cjs
  ---
  duration_ms: 51.70215
  type: 'test'
  ...
# Subtest: teacher startup does not create defaults and removes only school-wide pending flags
ok 210 - teacher startup does not create defaults and removes only school-wide pending flags
  ---
  duration_ms: 2.928794
  type: 'test'
  ...
# Subtest: school profile replaces stale teacher defaults while head teacher edits remain protected
ok 211 - school profile replaces stale teacher defaults while head teacher edits remain protected
  ---
  duration_ms: 2.48295
  type: 'test'
  ...
# Subtest: Grades is reachable from the teacher bottom navigation
ok 212 - Grades is reachable from the teacher bottom navigation
  ---
  duration_ms: 1.367948
  type: 'test'
  ...
# Subtest: fresh-device defaults do not override the cloud but real Setup edits survive
ok 213 - fresh-device defaults do not override the cloud but real Setup edits survive
  ---
  duration_ms: 3.914256
  type: 'test'
  ...
# Subtest: an explicitly named new school keeps its Term 1 choice queued
ok 214 - an explicitly named new school keeps its Term 1 choice queued
  ---
  duration_ms: 1.600946
  type: 'test'
  ...
# teacher identity, subject cleanup, and student freeze regression: PASS
# Subtest: tests/teacher-subject-student-freeze.test.cjs
ok 32 - tests/teacher-subject-student-freeze.test.cjs
  ---
  duration_ms: 54.195471
  type: 'test'
  ...
# Subtest: in-flight acknowledgement preserves and reschedules a newer edit
ok 216 - in-flight acknowledgement preserves and reschedules a newer edit
  ---
  duration_ms: 6.515705
  type: 'test'
  ...
# Subtest: overlapping pushes share one write and denied-class edits remain queued
ok 217 - overlapping pushes share one write and denied-class edits remain queued
  ---
  duration_ms: 1.722346
  type: 'test'
  ...
# Subtest: failed writes and obsolete sessions do not acknowledge the outbox
ok 218 - failed writes and obsolete sessions do not acknowledge the outbox
  ---
  duration_ms: 3.856675
  type: 'test'
  ...
# Subtest: cached offline identity cannot initiate writes before reverification
ok 219 - cached offline identity cannot initiate writes before reverification
  ---
  duration_ms: 1.572683
  type: 'test'
  ...
# Subtest: hydration preserves pending array, keyed and settings edits while accepting clean cloud data
ok 220 - hydration preserves pending array, keyed and settings edits while accepting clean cloud data
  ---
  duration_ms: 2.704743
  type: 'test'
  ...
# Subtest: storage quota failure leaves the previous saved value intact
ok 221 - storage quota failure leaves the previous saved value intact
  ---
  duration_ms: 1.267257
  type: 'test'
  ...
# Subtest: rollover snapshot uses browser-supported batch methods and rejects existing archive
ok 222 - rollover snapshot uses browser-supported batch methods and rejects existing archive
  ---
  duration_ms: 1.45777
  type: 'test'
  ...
# Subtest: emergency restore stops when its protective snapshot cannot be stored
ok 223 - emergency restore stops when its protective snapshot cannot be stored
  ---
  duration_ms: 1.285436
  type: 'test'
  ...
# Subtest: service-worker upgrade deletes only older SchoolHub caches
ok 224 - service-worker upgrade deletes only older SchoolHub caches
  ---
  duration_ms: 1.441414
  type: 'test'
  ...
# Subtest: moving an exception to School Open clears both cloud calendar dates atomically
ok 225 - moving an exception to School Open clears both cloud calendar dates atomically
  ---
  duration_ms: 1.321029
  type: 'test'
  ...
# v40 bulk safe delete regression checks passed.
# Subtest: tests/v40-bulk-safe-delete.test.cjs
ok 34 - tests/v40-bulk-safe-delete.test.cjs
  ---
  duration_ms: 48.871669
  type: 'test'
  ...
# calendar edit move/update regression: PASS
# Subtest: tests/v40-calendar-edit-fix.test.cjs
ok 35 - tests/v40-calendar-edit-fix.test.cjs
  ---
  duration_ms: 47.489002
  type: 'test'
  ...
# edit/update labels regression: PASS
# Subtest: tests/v40-edit-update-labels.test.cjs
ok 36 - tests/v40-edit-update-labels.test.cjs
  ---
  duration_ms: 45.883548
  type: 'test'
  ...
# firestore image sanitizer regression: PASS
# Subtest: tests/v40-firestore-image-sanitizer.test.cjs
ok 37 - tests/v40-firestore-image-sanitizer.test.cjs
  ---
  duration_ms: 52.159349
  type: 'test'
  ...
# desktop grade input visibility regression: PASS
# Subtest: tests/v40-grade-input-desktop.test.cjs
ok 38 - tests/v40-grade-input-desktop.test.cjs
  ---
  duration_ms: 45.499614
  type: 'test'
  ...
# help/legal update regression: PASS
# Subtest: tests/v40-help-legal.test.cjs
ok 39 - tests/v40-help-legal.test.cjs
  ---
  duration_ms: 50.319078
  type: 'test'
  ...
# inline help/legal and copyright regression: PASS
# Subtest: tests/v40-inline-help-legal.test.cjs
ok 40 - tests/v40-inline-help-legal.test.cjs
  ---
  duration_ms: 41.645912
  type: 'test'
  ...
# login help and floating pill regression: PASS
# Subtest: tests/v40-login-help-pill.test.cjs
ok 41 - tests/v40-login-help-pill.test.cjs
  ---
  duration_ms: 47.70209
  type: 'test'
  ...
# offline-first authenticated mode regression: PASS
# Subtest: tests/v40-offline-first-auth.test.cjs
ok 42 - tests/v40-offline-first-auth.test.cjs
  ---
  duration_ms: 51.303509
  type: 'test'
  ...
# v40 stability/security regression checks passed.
# Subtest: tests/v40-stability-security.test.cjs
ok 43 - tests/v40-stability-security.test.cjs
  ---
  duration_ms: 43.144138
  type: 'test'
  ...
# year rollover regression: PASS
# Subtest: tests/v40-year-rollover.test.cjs
ok 44 - tests/v40-year-rollover.test.cjs
  ---
  duration_ms: 57.675075
  type: 'test'
  ...
# Subtest: weekends remain closed even when a calendar record says open
ok 237 - weekends remain closed even when a calendar record says open
  ---
  duration_ms: 2.96702
  type: 'test'
  ...
# Subtest: existing weekend marks do not count for pupils, teachers or report cards
ok 238 - existing weekend marks do not count for pupils, teachers or report cards
  ---
  duration_ms: 2.276482
  type: 'test'
  ...
# Subtest: school-wide strikes suppress saved marks without erasing them
ok 239 - school-wide strikes suppress saved marks without erasing them
  ---
  duration_ms: 1.397127
  type: 'test'
  ...
# Subtest: individual strike is separate from absence and ratio policy is explicit
ok 240 - individual strike is separate from absence and ratio policy is explicit
  ---
  duration_ms: 2.514738
  type: 'test'
  ...
# Subtest: all open-date calculations exclude a weekday school strike
ok 241 - all open-date calculations exclude a weekday school strike
  ---
  duration_ms: 1.6058
  type: 'test'
  ...
# whole-app theme consistency regression: PASS
# Subtest: tests/whole-app-theme-consistency.test.cjs
ok 46 - tests/whole-app-theme-consistency.test.cjs
  ---
  duration_ms: 31.588355
  type: 'test'
  ...
1..242
# tests 242
# suites 0
# pass 242
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1242.006721
