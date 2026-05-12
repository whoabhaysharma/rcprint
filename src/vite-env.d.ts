/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Set "true" to use production Firebase Auth/Firestore/Storage during `npm run dev`.
   * Default (unset) = connect to local emulators on localhost / 127.0.0.1.
   */
  readonly VITE_USE_PRODUCTION_FIREBASE?: string;

  /**
   * When "true", map Razorpay public-topup API paths to the Functions emulator HTTP URL
   * even if the app is not served from Hosting :5000 (edge cases / testing).
   */
  readonly VITE_FUNCTIONS_EMULATOR_HTTP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
