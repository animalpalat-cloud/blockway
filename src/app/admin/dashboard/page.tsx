"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Globe2,
  LogOut,
  Shield,
  Users,
  Zap,
} from "lucide-react";
import { useAuth }  from "@/contexts/AuthContext";
import { logOut }   from "@/lib/firebase/auth";

const STATS = [
  { label: "Total Proxy Requests", value: "—",    icon: Globe2,   color: "text-blue-600",   bg: "bg-blue-50" },
  { label: "Active Users",          value: "—",    icon: Users,    color: "text-indigo-600", bg: "bg-indigo-50" },
  { label: "Uptime",                value: "99.9%",icon: Activity, color: "text-emerald-600",bg: "bg-emerald-50" },
  { label: "Bandwidth Used",        value: "—",    icon: Zap,      color: "text-amber-600",  bg: "bg-amber-50" },
];

export default function DashboardPage() {
  const { user }  = useAuth();
  const router    = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    await logOut();
    router.push("/admin/login");
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white">
              <Shield size={17} />
            </div>
            <span className="text-base font-extrabold tracking-tight text-slate-900">
              Proxy<span className="text-blue-600">Hub</span>{" "}
              <span className="font-normal text-slate-400">Admin</span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Avatar */}
            <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
                {(user?.displayName ?? user?.email ?? "A")[0].toUpperCase()}
              </div>
              <span className="hidden text-sm font-medium text-slate-700 sm:block">
                {user?.displayName ?? user?.email}
              </span>
            </div>

            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              <LogOut size={15} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
            Welcome back,{" "}
            <span className="text-blue-600">
              {user?.displayName ?? "Admin"}
            </span>{" "}
            👋
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Here&apos;s an overview of your ProxyHub platform.
          </p>
        </div>

        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((stat) => (
            <div
              key={stat.label}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className={`mb-3 inline-flex rounded-xl p-2.5 ${stat.bg}`}>
                <stat.icon size={18} className={stat.color} />
              </div>
              <p className="text-2xl font-extrabold text-slate-900">{stat.value}</p>
              <p className="mt-0.5 text-xs font-medium text-slate-500">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Coming soon banner */}
        <div className="mt-8 rounded-3xl border border-dashed border-blue-200 bg-blue-50/50 p-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100 text-blue-600">
            <Zap size={26} />
          </div>
          <h2 className="text-lg font-bold text-slate-900">
            Full Dashboard Coming Soon
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            Proxy analytics, user management, server health, bandwidth charts
            and more will appear here. Authentication is live and working.
          </p>
        </div>
      </main>
    </div>
  );
}
