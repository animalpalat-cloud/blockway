import { Shield } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

interface AuthCardProps {
  title:       string;
  description: string;
  children:    ReactNode;
  footer?:     ReactNode;
}

export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50/30 to-white px-4 py-12">
      {/* Background blobs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-blue-200/25 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-indigo-200/25 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Link href="/" className="group flex items-center gap-2.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-md shadow-blue-200 transition-transform group-hover:scale-105">
              <Shield size={20} />
            </div>
            <span className="text-xl font-extrabold tracking-tight text-slate-900">
              Proxy<span className="text-blue-600">Hub</span>
            </span>
          </Link>
        </div>

        {/* Card */}
        <div className="rounded-3xl border border-slate-200/80 bg-white/90 p-8 shadow-xl shadow-slate-200/60 backdrop-blur-sm">
          {/* Header */}
          <div className="mb-7 text-center">
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
              {title}
            </h1>
            <p className="mt-1.5 text-sm text-slate-500">{description}</p>
          </div>

          {children}
        </div>

        {/* Below-card link */}
        {footer ? (
          <div className="mt-5 text-center text-sm text-slate-500">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
