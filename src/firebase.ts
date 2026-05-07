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

// Connect to emulators in development
if (import.meta.env.DEV && typeof window !== 'undefined' && window.location.hostname === 'localhost') {
  try {
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, 'localhost', 8080);
    connectStorageEmulator(storage, 'localhost', 9199);
    console.log('Connected to Firebase emulators');
  } catch (error) {
    console.warn('Firebase emulators already connected or not available');
  }
}
