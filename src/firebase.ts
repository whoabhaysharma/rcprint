import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

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
