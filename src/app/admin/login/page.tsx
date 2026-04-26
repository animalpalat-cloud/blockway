"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";

import { signIn, parseFirebaseError } from "@/lib/firebase/auth";
import { AuthCard }    from "@/components/auth/AuthCard";
import { AuthInput }   from "@/components/auth/AuthInput";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { AuthButton }  from "@/components/auth/AuthButton";
import { AuthAlert }   from "@/components/auth/AuthAlert";

interface FormErrors {
  email?:    string;
  password?: string;
}

export default function LoginPage() {
  const router = useRouter();

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [errors,   setErrors]   = useState<FormErrors>({});
  const [apiError, setApiError] = useState("");
  const [loading,  setLoading]  = useState(false);

  function validate(): boolean {
    const newErrors: FormErrors = {};
    if (!email.trim()) {
      newErrors.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Enter a valid email address.";
    }
    if (!password) {
      newErrors.password = "Password is required.";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setApiError("");
    if (!validate()) return;

    setLoading(true);
    try {
      await signIn(email, password);
      router.push("/admin/dashboard");
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      setApiError(parseFirebaseError(code));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Admin Login"
      description="Sign in to manage your ProxyHub dashboard"
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link href="/admin/signup" className="font-semibold text-blue-600 hover:underline">
            Create account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {apiError && <AuthAlert type="error" message={apiError} />}

        <AuthInput
          label="Email address"
          type="email"
          icon={Mail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.com"
          error={errors.email}
          autoComplete="email"
        />

        <PasswordInput
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password"
          error={errors.password}
          autoComplete="current-password"
        />

        {/* Remember me */}
        <div className="flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 accent-blue-600"
            />
            Remember me
          </label>
          <a href="#" className="text-sm font-medium text-blue-600 hover:underline">
            Forgot password?
          </a>
        </div>

        <div className="pt-1">
          <AuthButton type="submit" loading={loading}>
            Sign In
          </AuthButton>
        </div>

        {/* Divider */}
        <div className="relative flex items-center gap-3 py-1">
          <div className="flex-1 border-t border-slate-200" />
          <span className="text-xs text-slate-400">or continue with</span>
          <div className="flex-1 border-t border-slate-200" />
        </div>

        {/* Google placeholder */}
        <button
          type="button"
          disabled
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {/* Google "G" mark SVG */}
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google (coming soon)
        </button>
      </form>
    </AuthCard>
  );
}
