import { getApp, getApps, initializeApp } from "firebase/app";

const firebaseConfig = {
  apiKey:            "AIzaSyAgpMcIQInFxhnNN2SfTeKTdufpNtgnORI",
  authDomain:        "proxyhub-13bb0.firebaseapp.com",
  projectId:         "proxyhub-13bb0",
  storageBucket:     "proxyhub-13bb0.firebasestorage.app",
  messagingSenderId: "399613903749",
  appId:             "1:399613903749:web:76ec40b5ff2950a1ca3aec",
  measurementId:     "G-26ZLVEZ9BQ",
};

// Guard against duplicate initializations during Next.js hot-reload.
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export { app };
