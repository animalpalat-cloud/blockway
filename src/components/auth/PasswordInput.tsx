"use client";

import { Eye, EyeOff, Lock } from "lucide-react";
import { useState, type InputHTMLAttributes } from "react";
import { AuthInput } from "./AuthInput";

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
}

export function PasswordInput({
  label = "Password",
  error,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <AuthInput
      {...props}
      type={visible ? "text" : "password"}
      label={label}
      icon={Lock}
      error={error}
      rightSlot={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="text-slate-400 transition-colors hover:text-blue-600"
          tabIndex={-1}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      }
    />
  );
}
