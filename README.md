# AlatiphA SchoolHub v40
## Phase 4 — Freemium Billing & Report Credits

SchoolHub remains free for school management. Premium report-card generation uses school-owned Report Credits.

### Pricing
- Each school receives 10 free single Black & White PDF generations per term and academic year, then pays 1 report credit per generation
- Class batch PDF generation requires credits for every report, regardless of theme
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

Theme 1 Black & White includes 10 free single PDF generations per school per term and academic year. After that, each costs one credit. The server tracks this allowance across school members and devices; returning to an earlier term does not reset its usage. Batch PDFs remain one credit per report. Guest trials include at most 10 single Black & White reports per browser. Theme previews are watermarked samples. Printing a previously generated PDF does not incur another charge. These deductions currently use test credits only; live billing remains disabled. Premium themes require the school to have at least one available credit before they can be applied, and each generated premium report card consumes one credit.

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


## Current v39 status

Billing and Report Credits are temporarily suspended in the frontend while the Staff module is being expanded. The billing/payment code and Firebase Functions remain in the package and have not been deleted. During this suspension, report generation is not credit-gated.

### Staff fields added in v39

Staff records now include Sex, EMIS No., Email, Bank & Branch, Bank Account, Rank/Grade dropdown, Notional Date, Substantive Date, Academic Qualification dropdown, and Professional Qualification dropdown, with the requested staff-detail order.


## v40 Data-Loss Patch

v40 adds a data-preservation layer to the Phase 4 v39 build.

### What was fixed

- Firestore pull operations no longer trigger an automatic cloud push.
- A persistent local recovery snapshot is created before cloud hydration.
- Cloud records are merged into the existing local cache instead of blindly replacing it.
- Empty or incomplete local collections cannot trigger mass deletion of cloud records.
- Student, class, subject, staff, grade, attendance, calendar and remark data are protected by the same recovery approach.
- Service-worker cache is bumped to v40 so browsers do not continue serving the v39 JavaScript.
- Existing v39 billing suspension remains unchanged.

### Important deployment rule

Deploy the complete v40 package together. Do not mix the v40 `app-4.js` with an older service worker or older `index.html`.

v40 is designed to stop the v39 data-loss mechanism. If records were already deleted from both Firestore and the browser's local storage by v39, v40 cannot reconstruct those records without another backup or copy. If the records still exist in Firestore, v40 will pull them without immediately pushing a partial local cache back over them.
