"use client";

import { motion } from "framer-motion";
import { CheckCircle2, Link2, Settings2, Sparkles } from "lucide-react";
import { SectionTitle } from "./SectionTitle";

const steps = [
  {
    number: "01",
    title: "Paste Your URL",
    description:
      "Type or paste any website address into the proxy bar. No account or browser extension needed.",
    icon: Link2,
    color: "text-blue-600",
    bg:    "bg-blue-50",
    ring:  "ring-blue-100",
  },
  {
    number: "02",
    title: "We Fetch & Filter",
    description:
      "ProxyHub securely fetches the page, strips tracking scripts, and rewrites all links through our encrypted tunnel.",
    icon: Settings2,
    color: "text-indigo-600",
    bg:    "bg-indigo-50",
    ring:  "ring-indigo-100",
  },
  {
    number: "03",
    title: "Browse Freely",
    description:
      "The page loads privately inside your browser. Click any link — it stays proxied the whole session.",
    icon: Sparkles,
    color: "text-emerald-600",
    bg:    "bg-emerald-50",
    ring:  "ring-emerald-100",
  },
];

export function HowItWorksSection() {
  return (
    <section id="how-it-works" className="px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl">
        <SectionTitle
          eyebrow="How It Works"
          title="Three Steps to Open Internet"
          description="No configuration. No downloads. Just paste a link and go."
        />

        <div className="relative grid gap-6 md:grid-cols-3">

          {/* Connecting lines (visible on md+) */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 top-[3.5rem] hidden h-px bg-gradient-to-r from-transparent via-blue-200 to-transparent md:block"
          />

          {steps.map((step, index) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 22 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.45, delay: index * 0.13 }}
              className="relative flex flex-col items-start rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"
            >
              {/* Step number bubble */}
              <div
                className={`relative z-10 mb-5 flex h-12 w-12 items-center justify-center rounded-2xl ring-4 ${step.bg} ${step.ring}`}
              >
                <step.icon size={20} className={step.color} />
                <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white">
                  {index + 1}
                </span>
              </div>

              <span className="mb-1 text-xs font-bold tracking-widest text-slate-300">
                {step.number}
              </span>
              <h3 className="text-lg font-bold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">{step.description}</p>

              {/* Done indicator on last card */}
              {index === steps.length - 1 && (
                <div className="mt-5 flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                  <CheckCircle2 size={14} />
                  You&apos;re browsing privately
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
