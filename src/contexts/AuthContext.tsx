"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "@/lib/firebase/auth";

// ADD THIS IMPORT
import { proxyFetch } from "@/lib/proxy/clientProxy";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);

      // EXAMPLE PROXY FETCH USAGE
      try {
        const response = await proxyFetch(
          "https://accounts.google.com/...",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              uid: firebaseUser?.uid,
            }),
          }
        );

        const data = await response.json();
        console.log("Proxy response:", data);
      } catch (error) {
        console.error("Proxy fetch error:", error);
      }
    });

    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}