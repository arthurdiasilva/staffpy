// src/lib/firebase.ts
import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCCHgOgHYJf5lU-lKXEap547XfHqjcghF4",
  authDomain: "staffpy-43639.firebaseapp.com",
  projectId: "staffpy-43639",
  storageBucket: "staffpy-43639.firebasestorage.app",
  messagingSenderId: "904410728993",
  appId: "1:904410728993:web:17fc4a588911ac31c57160",
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
