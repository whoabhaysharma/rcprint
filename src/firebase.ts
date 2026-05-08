import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, connectStorageEmulator } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAeAWyqgb4HVIKRuk-Ox2LCgQZ6S1JZuv0",
  authDomain: "gen-lang-client-0810421212.firebaseapp.com",
  projectId: "gen-lang-client-0810421212",
  storageBucket: "gen-lang-client-0810421212.firebasestorage.app",
  messagingSenderId: "268167672607",
  appId: "1:268167672607:web:8e7ff92f337f287b6d362a",
  measurementId: "G-9MSQ9W0S6K"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);

/**
 * Local dev: use the full emulator stack (must run `npm run emulators` first).
 * Opt out with VITE_USE_PRODUCTION_FIREBASE=true if you need real Auth/Firestore/Storage.
 */
const isLocalDevHost = () =>
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

const useProductionFirebase =
  import.meta.env.VITE_USE_PRODUCTION_FIREBASE === 'true' ||
  import.meta.env.VITE_USE_PRODUCTION_FIREBASE === '1';

/**
 * Use local emulators whenever running on localhost/127.0.0.1 unless explicitly forced to production.
 * This allows the Hosting emulator (:5000) to work too (it serves a production build where DEV=false).
 */
const useFirebaseEmulators = isLocalDevHost() && !useProductionFirebase;

if (useFirebaseEmulators) {
  try {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
    console.info('[Firebase] Emulators — auth:9099 firestore:8080 storage:9199 (run `npm run emulators`)');
  } catch (error) {
    console.warn('[Firebase] Emulator connect skipped or already connected', error);
  }
}
