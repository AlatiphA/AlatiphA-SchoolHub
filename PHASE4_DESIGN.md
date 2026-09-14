# AlatiphA SchoolHub Phase 4

## Freemium school billing

SchoolHub remains free for school management. Premium actions use school-owned Report Credits.

- 1 report card generation = 1 credit = GH₵0.20
- Credits belong to the school, not individual teachers or devices.
- Head Teacher controls purchases and billing.
- Active teachers can use the school's credits to generate reports for classes they can access.
- Theme previews remain free. Applying a premium theme requires at least 1 available credit.
- Theme 1 Black & White is fully free for report generation. Premium themes use report credits.
- CSV exports and normal data management remain free.

## Payment architecture

Paystack is used for payment. The browser only receives the Paystack public key. Payment initialization and verification happen in Firebase Cloud Functions using the Paystack secret key. Credits are granted only after server-side verification of successful status and exact expected amount.

Set the Firebase Functions secret:

`firebase functions:secrets:set PAYSTACK_SECRET_KEY`

Set the public key in `firebase-config.js`:

`window.PAYSTACK_PUBLIC_KEY = "pk_test_..."` for testing, then the live public key for production.
