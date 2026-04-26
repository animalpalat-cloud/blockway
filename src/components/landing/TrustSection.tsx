"use client";

import { motion, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Globe2, ShieldCheck, Users, Zap } from "lucide-react";

const STATS = [
  { value: 120000, suffix: "+", label: "Active Users",      icon: Users },
  { value: 99.9,   suffix: "%", label: "Uptime SLA",        icon: Zap,   decimal: 1 },
  { value: 50,     suffix: "+", label: "Global Servers",    icon: Globe2 },
  { value: 100,    suffix: "%", label: "No-Log Guarantee",  icon: ShieldCheck },
];

function Counter({ target, suffix, decimal = 0 }: { target: number; suffix: string; decimal?: number }) {
  const [count, setCount] = useState(0);
  const ref              = useRef<HTMLSpanElement>(null);
  const inView           = useInView(ref, { once: true });

  useEffect(() => {
    if (!inView) return;
    let start    = 0;
    const step   = target / 60;
    const timer  = setInterval(() => {
      start += step;
      if (start >= target) { setCount(target); clearInterval(timer); }
      else setCount(start);
    }, 16);
    return () => clearInterval(timer);
  }, [inView, target]);

  return (
    <span ref={ref}>
      {decimal > 0 ? count.toFixed(decimal) : Math.floor(count).toLocaleString()}
      {suffix}
    </span>
  );
}

export function TrustSection() {
  return (
    <section className="bg-blue-600 px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl">

        {/* Stats strip */}
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          {STATS.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="flex flex-col items-center gap-2 text-center"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 text-white">
                <stat.icon size={20} />
              </div>
              <p className="text-3xl font-extrabold tracking-tight text-white">
                <Counter target={stat.value} suffix={stat.suffix} decimal={stat.decimal} />
              </p>
              <p className="text-sm font-medium text-blue-100">{stat.label}</p>
            </motion.div>
          ))}
        </div>

        {/* Divider */}
        <div className="my-12 h-px bg-blue-500/50" />

        {/* About / info block */}
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, x: -16 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5 }}
          >
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-blue-200">
              About ProxyHub
            </p>
            <h2 className="text-3xl font-extrabold leading-snug tracking-tight text-white sm:text-4xl">
              Why Millions Choose<br className="hidden sm:block" /> Our Proxy Network
            </h2>
            <p className="mt-4 text-base leading-7 text-blue-100">
              ProxyHub is built for people who value their digital freedom. Whether you're
              bypassing workplace restrictions, protecting yourself on public Wi-Fi, or
              accessing region-locked content — our proxy infrastructure delivers a fast,
              encrypted tunnel to any website on the open internet.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 16 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            {[
              { title: "No Browser Plugin",    body: "Works in any modern browser without any extension or software." },
              { title: "School & Work Safe",   body: "Bypass network filters on institutional Wi-Fi securely." },
              { title: "Mobile Friendly",      body: "Optimised for phones and tablets — same speed, smaller screen." },
              { title: "Open & Transparent",   body: "Our infrastructure is audited and we publish transparency reports." },
            ].map((item) => (
              <div key={item.title} className="rounded-2xl bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-sm font-bold text-white">{item.title}</p>
                <p className="mt-1.5 text-xs leading-5 text-blue-100">{item.body}</p>
              </div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
