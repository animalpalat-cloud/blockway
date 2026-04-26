"use client";

import { motion } from "framer-motion";
import { Eye, Gauge, Globe2, Lock, Server, Zap } from "lucide-react";
import { SectionTitle } from "./SectionTitle";

const PRIMARY = [
  {
    title: "Blazing Fast Speed",
    description:
      "Routes optimized across low-latency nodes globally so pages load in milliseconds, not seconds.",
    icon: Gauge,
    accent: "bg-blue-50 text-blue-600",
    wide: true,
  },
  {
    title: "Zero-Log Privacy",
    description:
      "We never store your browsing history. Your data is yours — always.",
    icon: Eye,
    accent: "bg-indigo-50 text-indigo-600",
    wide: false,
  },
];

const SECONDARY = [
  {
    title: "End-to-End Encryption",
    description: "Every request travels through TLS tunnels, shielded from trackers.",
    icon: Lock,
    accent: "bg-sky-50 text-sky-600",
  },
  {
    title: "Unlimited Access",
    description: "No country restrictions, no paywalls — open internet for everyone.",
    icon: Globe2,
    accent: "bg-emerald-50 text-emerald-600",
  },
  {
    title: "Global Edge Servers",
    description: "50+ proxy nodes across 20 regions for optimal speed wherever you are.",
    icon: Server,
    accent: "bg-violet-50 text-violet-600",
  },
  {
    title: "Instant Activation",
    description: "No install, no sign-up required. Paste a URL and you're browsing.",
    icon: Zap,
    accent: "bg-amber-50 text-amber-600",
  },
];

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, delay: i * 0.07, ease: "easeOut" as const },
  }),
};

export function FeaturesSection() {
  return (
    <section id="features" className="bg-slate-50/70 px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl">
        <SectionTitle
          eyebrow="Features"
          title="Built for Speed, Privacy & Freedom"
          description="Everything you need for a truly open internet — engineered to be fast, safe, and effortless."
        />

        {/* Top row — 2 cards: wide + narrow */}
        <div className="grid gap-4 sm:grid-cols-3">
          {PRIMARY.map((item, i) => (
            <motion.div
              key={item.title}
              custom={i}
              variants={cardVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.15 }}
              whileHover={{ y: -4 }}
              className={`group relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-7 shadow-sm transition-shadow hover:shadow-md ${
                item.wide ? "sm:col-span-2" : "sm:col-span-1"
              }`}
            >
              {/* Subtle corner gradient on hover */}
              <div className="pointer-events-none absolute right-0 top-0 h-32 w-32 translate-x-8 -translate-y-8 rounded-full bg-blue-100/50 blur-2xl transition-all duration-500 group-hover:translate-x-4 group-hover:-translate-y-4" />
              <div className={`mb-5 inline-flex rounded-2xl p-3.5 ${item.accent}`}>
                <item.icon size={22} />
              </div>
              <h3 className="text-xl font-bold text-slate-900">{item.title}</h3>
              <p className="mt-2.5 text-sm leading-6 text-slate-500">{item.description}</p>
            </motion.div>
          ))}
        </div>

        {/* Bottom row — 4 equal cards */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SECONDARY.map((item, i) => (
            <motion.div
              key={item.title}
              custom={i + 2}
              variants={cardVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.15 }}
              whileHover={{ y: -4 }}
              className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className={`mb-4 inline-flex rounded-xl p-3 ${item.accent}`}>
                <item.icon size={19} />
              </div>
              <h3 className="text-base font-bold text-slate-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
