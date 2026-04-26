import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface AuthButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  children: ReactNode;
}

export function AuthButton({ loading = false, children, disabled, className = "", ...props }: AuthButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`relative flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-bold text-white shadow-sm shadow-blue-200 transition-all
        hover:bg-blue-700 active:scale-[0.98]
        disabled:cursor-not-allowed disabled:opacity-60
        ${className}`}
    >
      {loading ? (
        <>
          <Loader2 size={16} className="animate-spin" />
          Please wait…
        </>
      ) : children}
    </button>
  );
}
