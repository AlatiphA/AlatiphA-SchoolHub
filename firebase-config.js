// AlatiphA SchoolHub — Firebase configuration
//
// This is a SEPARATE Firebase project from AlatiphA Report Cards — keep
// them independent. Create a new project at console.firebase.google.com,
// enable Authentication (Email/Password and Google), Firestore, and Storage, then paste that
// project's config values below.
//
// Until real values are set, the app has no working accounts/sync.

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyADvwL7iA8ZY4xbT90Iz8MCy48iwCEWzWI",
  authDomain: "alatipha-schoolhub.firebaseapp.com",
  projectId: "alatipha-schoolhub",
  storageBucket: "alatipha-schoolhub.firebasestorage.app"
};

// Paystack public key only. Never place the Paystack secret key in this file.
// Use a test public key while testing, then replace it with the live public key.
window.PAYSTACK_PUBLIC_KEY = "pk_test_20c396303090791c7267c5c93c6204efa33b1655";
