# FIS Reminder Feedback and Table UX Patch

This patch is a presentation and interaction refinement for the existing Fees & Receipts system. It does not change the FIS data model, Firebase Functions, Firestore rules, fee calculations, payment allocation, reversals, arrears logic, reminder contents, WhatsApp URL generation, or offline safeguards.

## Reminder action feedback

- Copy Message now shows a visible toast: `Reminder copied to clipboard.`
- The Copy button temporarily changes to `Copied` and returns to its normal label automatically.
- Clipboard failures show an actionable error toast instead of failing silently.
- Open WhatsApp shows `Opening WhatsApp…`. SchoolHub still only opens the prepared WhatsApp link and never claims that a message was sent.
- A blocked WhatsApp pop-up shows an error telling the user to check browser pop-up settings.
- Print / Save reminder PDF shows `Reminder print preview opened.` after opening the existing print preview.
- Toasts are non-blocking, accessible with `role="status"` / `aria-live`, and sit above the mobile bottom navigation.

## Fees & Receipts table behavior

- Every table inside Fees & Receipts can scroll horizontally on narrow screens.
- Normal page vertical scrolling remains unchanged.
- Table headings are centered.
- Table body values are centered for consistent column alignment, while the frozen row-label/name column remains left aligned for readability.
- The first row-label column is sticky/frozen for all FIS tables.
- Arrears Management freezes both its Select column and the Pupil / guardian column, so the pupil name remains visible while scrolling horizontally.
- Receipt allocation and print-preview tables receive the same horizontal-scroll behavior.
- Sticky positioning is disabled for printed output so printed/PDF tables retain normal layout.

## Safety

This patch is client-side only. It does not modify:

- `functions/`
- `firestore.rules`
- `storage.rules`
- FIS financial mutation logic
- fee categories/items/charges schema
- payment allocation/reversal logic
- reminder balance selection rules
- guardian data
- WhatsApp message text or destination rules
- service-worker Background Sync logic

The service-worker cache name is bumped only so installed PWAs receive the updated JavaScript and CSS.
