# AlatiphA SchoolHub Phase 3 v38.10.2

## Report Card Visual Refinements

This release builds on v38.9 and adds persistent navigation state.

### Key fixes
- Firebase authentication remains locally persistent.
- Login is not shown while an existing session is being restored.
- Browser refresh restores the last valid SchoolHub page instead of always opening Home.
- Attendance sub-tab is restored as well (Students, Teachers, Calendar, Summary, Analytics, Reports).
- The saved page is not overwritten by the temporary Home screen used while cloud data is loading.
- Pull-to-refresh remains enabled.
- Local-first startup and background cloud synchronization are retained.

### Expected behaviour
If the user is on `Attendance > Analytics` and refreshes the browser, SchoolHub returns to `Attendance > Analytics` after the authenticated school data is ready.

If there is no authenticated session, the normal Sign In screen is shown.


## v38.10.2 Report Card Refinements
- Removed the gold border around student photographs.
- Reordered Student Information to Name, Roll / ID, Class, Position.
- Expanded and centered the results table to the full report content width.
- Removed teacher names from signature cards and reduced signature-card height.
- Reduced Grading Scale and Remarks Guide card height to fit their two-line content tightly.
- Footer now shows Phone: +233243443688, Designed with AlatiphA SchoolHub, and Email: alatipha@ymail.com.
