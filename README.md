# AlatiphA SchoolHub Phase 3 v38.11.1

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


## v38.10.3 Report Card Refinements
- Removed the gold border around student photographs.
- Reordered Student Information to Name, Roll / ID, Class, Position.
- Expanded and centered the results table to the full report content width.
- Removed teacher names from signature cards and reduced signature-card height.
- Reduced Grading Scale and Remarks Guide card height to fit their two-line content tightly.
- Footer now shows Phone: +233243443688, Designed with AlatiphA SchoolHub, and Email: alatipha@ymail.com.


## v38.10.3 Report Card Bottom Layout
- Signature/date cards are equally spaced: Class Teacher | Date of Issue | Head Teacher.
- Footer height reduced for more printable space.


## v38.11.1 Report Card Theme UI Refinements

- Improved theme picker text contrast in light mode.
- Reduced Preview and Apply button height and padding.
- Kept theme previews and report generation unchanged.

## v38.11.0 Report Card Themes
- Added a school-level Report Card Theme selector.
- Added four visual themes: SchoolHub Professional, Modern Academic, Classic Academic, and Executive.
- The selected theme is stored in school settings and follows the existing Firestore/local sync model.
- Report calculations and data remain centralized and unchanged; themes affect presentation only.
- Added theme cards with Apply/Active states and PDF Preview for the selected class.
- Existing v38.10.3 SchoolHub Professional design remains the default/fallback theme.
