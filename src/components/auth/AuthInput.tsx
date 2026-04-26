import type { InputHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

interface AuthInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label:      string;
  icon?:      LucideIcon;
  error?:     string;
  rightSlot?: React.ReactNode;
}

export function AuthInput({
  label,
  icon: Icon,
  error,
  rightSlot,
  className = "",
  ...props
}: AuthInputProps) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      <div className="relative">
        {Icon && (
          <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-slate-400">
            <Icon size={16} />
          </span>
        )}
        <input
          {...props}
          className={`h-11 w-full rounded-xl border bg-slate-50 text-sm text-slate-900 outline-none transition
            placeholder:text-slate-400
            ${Icon ? "pl-10" : "pl-4"}
            ${rightSlot ? "pr-11" : "pr-4"}
            ${error
              ? "border-red-300 ring-2 ring-red-100 focus:border-red-400"
              : "border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            }
            ${className}`}
        />
        {rightSlot && (
          <span className="absolute inset-y-0 right-0 flex items-center pr-3">
            {rightSlot}
          </span>
        )}
      </div>
      {error && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
