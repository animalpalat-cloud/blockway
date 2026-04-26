import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";

import { app } from "./config";

export const auth = getAuth(app);

// ── Sign up ────────────────────────────────────────────────────────────────────
export async function signUp(name: string, email: string, password: string): Promise<User> {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  // Attach display name immediately so dashboard can greet the user by name.
  await updateProfile(credential.user, { displayName: name });
  return credential.user;
}

// ── Sign in ────────────────────────────────────────────────────────────────────
export async function signIn(email: string, password: string): Promise<User> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

// ── Sign out ───────────────────────────────────────────────────────────────────
export async function logOut(): Promise<void> {
  await signOut(auth);
}

// ── Human-readable Firebase error messages ────────────────────────────────────
export function parseFirebaseError(code: string): string {
  const map: Record<string, string> = {
    "auth/email-already-in-use":   "An account with this email already exists.",
    "auth/invalid-email":          "Please enter a valid email address.",
    "auth/weak-password":          "Password must be at least 6 characters.",
    "auth/user-not-found":         "No account found with this email.",
    "auth/wrong-password":         "Incorrect password. Please try again.",
    "auth/invalid-credential":     "Invalid email or password.",
    "auth/too-many-requests":      "Too many failed attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Check your internet connection.",
    "auth/user-disabled":          "This account has been disabled.",
  };
  return map[code] ?? "An unexpected error occurred. Please try again.";
}
