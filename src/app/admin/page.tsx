import { redirect } from "next/navigation";

/**
 * /admin has no content of its own.
 * Server-side redirect happens instantly before any JS loads —
 * no flash, no client-side layout guard needed for this route.
 */
export default function AdminIndexPage() {
  redirect("/admin/login");
}
