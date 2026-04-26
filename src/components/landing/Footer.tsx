import { Globe, Mail, MessageCircle, Shield, ShieldCheck } from "lucide-react";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Features",     href: "#features" },
      { label: "How It Works", href: "#how-it-works" },
      { label: "Pricing",      href: "#pricing" },
      { label: "Changelog",    href: "#" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About",        href: "#" },
      { label: "Blog",         href: "#" },
      { label: "Careers",      href: "#" },
      { label: "Contact",      href: "#contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy Policy",    href: "#" },
      { label: "Terms of Service",  href: "#" },
      { label: "Cookie Policy",     href: "#" },
      { label: "Security",          href: "#" },
    ],
  },
];

const SOCIALS = [
  { label: "Website",  icon: Globe,          href: "#" },
  { label: "Email",    icon: Mail,           href: "#" },
  { label: "Chat",     icon: MessageCircle,  href: "#" },
  { label: "Security", icon: ShieldCheck,    href: "#" },
];

export function Footer() {
  return (
    <footer id="contact" className="border-t border-slate-200 bg-white px-4 pt-14 pb-8 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl">

        {/* Main grid */}
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">

          {/* Brand column */}
          <div>
            <a href="#" className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white">
                <Shield size={17} />
              </div>
              <span className="text-base font-extrabold tracking-tight text-slate-900">
                Proxy<span className="text-blue-600">Hub</span>
              </span>
            </a>
            <p className="mt-4 max-w-xs text-sm leading-6 text-slate-500">
              Open, encrypted, and unrestricted internet access — for everyone, everywhere.
            </p>
            <div className="mt-5 flex items-center gap-2.5">
              {SOCIALS.map(({ label, icon: Icon, href }) => (
                <a
                  key={label}
                  href={href}
                  aria-label={label}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
                >
                  <Icon size={15} />
                </a>
              ))}
            </div>
          </div>

          {/* Link columns */}
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">
                {col.heading}
              </p>
              <ul className="space-y-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-slate-600 transition-colors hover:text-blue-600"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-slate-200 pt-6 sm:flex-row">
          <p className="text-xs text-slate-400">
            &copy; {new Date().getFullYear()} ProxyHub. All rights reserved.
          </p>
          <p className="text-xs text-slate-400">
            Built with privacy in mind · No logs · No tracking
          </p>
        </div>
      </div>
    </footer>
  );
}
