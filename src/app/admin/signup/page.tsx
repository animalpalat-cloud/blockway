"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, User } from "lucide-react";

import { signUp, parseFirebaseError } from "@/lib/firebase/auth";
import { AuthCard }     from "@/components/auth/AuthCard";
import { AuthInput }    from "@/components/auth/AuthInput";
import { PasswordInput }from "@/components/auth/PasswordInput";
import { AuthButton }   from "@/components/auth/AuthButton";
import { AuthAlert }    from "@/components/auth/AuthAlert";

interface FormErrors {
  name?:            string;
  email?:           string;
  password?:        string;
  confirmPassword?: string;
}

const PASSWORD_RULES = [
  { test: (p: string) => p.length >= 8,          label: "At least 8 characters" },
  { test: (p: string) => /[A-Z]/.test(p),         label: "One uppercase letter" },
  { test: (p: string) => /[0-9]/.test(p),         label: "One number" },
];

export default function SignupPage() {
  const router = useRouter();

  const [name,            setName]            = useState("");
  const [email,           setEmail]           = useState("");
  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors,          setErrors]          = useState<FormErrors>({});
  const [apiError,        setApiError]        = useState("");
  const [loading,         setLoading]         = useState(false);

  const passwordStrength = PASSWORD_RULES.filter((r) => r.test(password)).length;
  const strengthLabel    = ["Weak", "Fair", "Good", "Strong"][passwordStrength] ?? "Weak";
  const strengthColors   = ["bg-red-400", "bg-amber-400", "bg-yellow-400", "bg-emerald-500"];

  function validate(): boolean {
    const newErrors: FormErrors = {};

    if (!name.trim()) {
      newErrors.name = "Full name is required.";
    } else if (name.trim().length < 2) {
      newErrors.name = "Name must be at least 2 characters.";
    }

    if (!email.trim()) {
      newErrors.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Enter a valid email address.";
    }

    if (!password) {
      newErrors.password = "Password is required.";
    } else if (password.length < 6) {
      newErrors.password = "Password must be at least 6 characters.";
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = "Please confirm your password.";
    } else if (password !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match.";
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
      await signUp(name.trim(), email, password);
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
      title="Create Admin Account"
      description="Set up your ProxyHub admin account to get started"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/admin/login" className="font-semibold text-blue-600 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {apiError && <AuthAlert type="error" message={apiError} />}

        <AuthInput
          label="Full name"
          type="text"
          icon={User}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Smith"
          error={errors.name}
          autoComplete="name"
        />

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

        <div className="space-y-1.5">
          <PasswordInput
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Create a strong password"
            error={errors.password}
            autoComplete="new-password"
          />

          {/* Strength meter */}
          {password.length > 0 && (
            <div>
              <div className="mt-1.5 flex gap-1">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-colors ${
                      i < passwordStrength ? strengthColors[passwordStrength - 1] : "bg-slate-200"
                    }`}
                  />
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Password strength:{" "}
                <span className={`font-semibold ${
                  passwordStrength <= 1 ? "text-red-500" :
                  passwordStrength === 2 ? "text-amber-500" : "text-emerald-600"
                }`}>{strengthLabel}</span>
              </p>
              <ul className="mt-2 space-y-1">
                {PASSWORD_RULES.map((rule) => (
                  <li key={rule.label} className={`flex items-center gap-1.5 text-xs ${
                    rule.test(password) ? "text-emerald-600" : "text-slate-400"
                  }`}>
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                      rule.test(password) ? "bg-emerald-500" : "bg-slate-300"
                    }`} />
                    {rule.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <PasswordInput
          label="Confirm password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Repeat your password"
          error={errors.confirmPassword}
          autoComplete="new-password"
        />

        {/* Terms */}
        <p className="text-xs leading-5 text-slate-500">
          By creating an account you agree to our{" "}
          <a href="#" className="font-medium text-blue-600 hover:underline">Terms of Service</a>{" "}
          and{" "}
          <a href="#" className="font-medium text-blue-600 hover:underline">Privacy Policy</a>.
        </p>

        <div className="pt-1">
          <AuthButton type="submit" loading={loading}>
            Create Account
          </AuthButton>
        </div>
      </form>
    </AuthCard>
  );
}
