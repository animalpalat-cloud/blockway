"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check, Zap } from "lucide-react";
import { SectionTitle } from "./SectionTitle";

const PLANS = [
  {
    name:     "Starter",
    monthlyPrice: 0,
    annualPrice:  0,
    badge:    null,
    features: [
      "5 GB bandwidth / month",
      "Standard speed proxy",
      "Basic encryption",
      "Community support",
    ],
    featured: false,
    cta:      "Start Free",
  },
  {
    name:     "Pro",
    monthlyPrice: 9,
    annualPrice:  7,
    badge:    "Most Popular",
    features: [
      "50 GB bandwidth / month",
      "High-speed edge routing",
      "TLS end-to-end encryption",
      "Priority email support",
      "Ad & tracker blocking",
    ],
    featured: true,
    cta:      "Get Pro",
  },
  {
    name:     "Unlimited",
    monthlyPrice: 19,
    annualPrice:  15,
    badge:    null,
    features: [
      "Unlimited bandwidth",
      "Premium global servers",
      "Full TLS + DNS-over-HTTPS",
      "24 / 7 live support",
      "Custom domain whitelist",
      "API access",
    ],
    featured: false,
    cta:      "Go Unlimited",
  },
];

export function PricingSection() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="pricing" className="bg-slate-50/70 px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl">
        <SectionTitle
          eyebrow="Pricing"
          title="Simple, Transparent Pricing"
          description="No hidden fees. Cancel anytime. Scale up or down as your needs change."
        />

        {/* Toggle */}
        <div className="mb-10 flex items-center justify-center gap-3">
          <span className={`text-sm font-medium ${!annual ? "text-slate-900" : "text-slate-400"}`}>Monthly</span>
          <button
            onClick={() => setAnnual((v) => !v)}
            aria-label="Toggle billing period"
            className="relative h-6 w-11 rounded-full bg-blue-600 transition-colors"
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-300 ${
                annual ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
          <span className={`text-sm font-medium ${annual ? "text-slate-900" : "text-slate-400"}`}>
            Annual
            <span className="ml-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              Save 20%
            </span>
          </span>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {PLANS.map((plan, index) => (
            <motion.article
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.4, delay: index * 0.08 }}
              className={`relative flex flex-col overflow-hidden rounded-3xl border p-7 shadow-sm transition-shadow hover:shadow-md ${
                plan.featured
                  ? "border-blue-400 bg-white ring-2 ring-blue-400/30 shadow-md"
                  : "border-slate-200 bg-white"
              }`}
            >
              {/* Badge */}
              {plan.badge && (
                <div className="absolute right-5 top-5 flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-xs font-bold text-white shadow-sm">
                  <Zap size={11} />
                  {plan.badge}
                </div>
              )}

              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                {plan.name}
              </p>

              <div className="mt-3 flex items-end gap-1">
                {plan.monthlyPrice === 0 ? (
                  <span className="text-5xl font-extrabold tracking-tight text-slate-900">Free</span>
                ) : (
                  <>
                    <span className="text-5xl font-extrabold tracking-tight text-slate-900">
                      ${annual ? plan.annualPrice : plan.monthlyPrice}
                    </span>
                    <span className="pb-1.5 text-sm text-slate-400">/mo</span>
                  </>
                )}
              </div>

              {plan.monthlyPrice > 0 && annual && (
                <p className="mt-1 text-xs text-slate-400">Billed annually</p>
              )}

              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2.5 text-sm text-slate-600">
                    <Check
                      size={15}
                      className={`shrink-0 ${plan.featured ? "text-blue-600" : "text-emerald-500"}`}
                    />
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                className={`mt-8 h-12 w-full rounded-xl text-sm font-bold transition-colors ${
                  plan.featured
                    ? "bg-blue-600 text-white shadow-sm shadow-blue-200 hover:bg-blue-700"
                    : "border border-slate-200 text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
                }`}
              >
                {plan.cta}
              </button>
            </motion.article>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-slate-400">
          All plans include SSL security, 99.9% uptime SLA, and 7-day money-back guarantee.
        </p>
      </div>
    </section>
  );
}
