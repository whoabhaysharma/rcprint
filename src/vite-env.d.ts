/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Set "true" to use production Firebase Auth/Firestore/Storage during `npm run dev`.
   * Default (unset) = connect to local emulators on localhost / 127.0.0.1.
   */
  readonly VITE_USE_PRODUCTION_FIREBASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
