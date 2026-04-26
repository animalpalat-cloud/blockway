"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

// /admin itself redirects server-side to /admin/login, but list it here
// too so the client guard never blocks it mid-flight.
const PUBLIC_PATHS = ["/admin", "/admin/login", "/admin/signup"];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router    = useRouter();
  const pathname  = usePathname();
  const isPublic  = PUBLIC_PATHS.includes(pathname);

  useEffect(() => {
    if (loading) return;

    if (!user && !isPublic) {
      // Not logged in — redirect to login.
      router.replace("/admin/login");
    }
    if (user && isPublic) {
      // Already logged in — skip the auth pages.
      router.replace("/admin/dashboard");
    }
  }, [user, loading, isPublic, router]);

  // Show a full-page spinner while Firebase resolves the session.
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 size={32} className="animate-spin text-blue-600" />
      </div>
    );
  }

  // Prevent a flash of protected content while redirect is in-flight.
  if (!user && !isPublic) return null;
  if (user  &&  isPublic) return null;

  return <>{children}</>;
}
