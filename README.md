# AlatiphA SchoolHub v38.11.17
## Phase 4 — Freemium Billing & Report Credits

SchoolHub remains free for school management. Premium report-card generation uses school-owned Report Credits.

### Pricing
- Black & White report cards are free
- Premium report card generation = 1 credit = GH₵0.20
- 10 credits = GH₵2.00
- 50 credits = GH₵10.00
- 100 credits = GH₵20.00
- 250 credits = GH₵50.00
- 500 credits = GH₵100.00
- 1,000 credits = GH₵200.00

### Who pays?
The Head Teacher purchases credits for the school. Credits are shared by authorized teachers in that school. Teachers do not pay individually and credits are not tied to a phone or PC.

### Free features
Students, classes, subjects, grades, attendance, remarks, CSV export, school management and report-theme previews remain available without credits.

Theme 1 Black & White is fully free for report generation. Premium themes require the school to have at least one available credit before they can be applied, and each generated premium report card consumes one credit.

### Payment security
Paystack is used for checkout. The browser contains only the Paystack public key. Payment initialization and verification are handled by Firebase Cloud Functions using the Paystack secret key. Client-side Firestore writes to billing, transactions and usage are blocked by Firestore rules.

## Configure Paystack

Edit `firebase-config.js`:

```js
window.PAYSTACK_PUBLIC_KEY = "pk_test_xxxxxxxxxxxxxxxxx";
```

Use the test public key while testing. Replace it with the live public key for production.

Never put the Paystack secret key in `firebase-config.js`, `app-4.js`, GitHub, or any other client-side file.

## Deploy Phase 4 Cloud Functions

From the project root:

```bash
firebase login
firebase use alatipha-schoolhub
firebase functions:secrets:set PAYSTACK_SECRET_KEY
firebase deploy --only functions,firestore:rules
```

When prompted for the secret, paste the Paystack Secret Key from the Paystack dashboard.

The functions are:

- `initializeReportCreditPurchase`
- `verifyReportCreditPurchase`
- `consumeReportCredits`

The first two are Head Teacher only. The third is available to active Head Teachers and Teachers and deducts credits atomically from the school's balance.

## Important

Do not grant report credits directly from the browser. If you need to manually credit a school during testing, do it from a trusted server/admin process or Firestore console.

The current frontend also provides a Verify Payment action so a Head Teacher can re-check a payment if the Paystack popup closes before the browser receives the success flow.
