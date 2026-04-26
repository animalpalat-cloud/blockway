import { AlertCircle, CheckCircle2 } from "lucide-react";

interface AuthAlertProps {
  type:    "error" | "success";
  message: string;
}

export function AuthAlert({ type, message }: AuthAlertProps) {
  const isError = type === "error";
  return (
    <div
      role="alert"
      className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ${
        isError
          ? "border border-red-100 bg-red-50 text-red-700"
          : "border border-emerald-100 bg-emerald-50 text-emerald-700"
      }`}
    >
      {isError
        ? <AlertCircle size={16} className="mt-0.5 shrink-0" />
        : <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
      <span>{message}</span>
    </div>
  );
}
