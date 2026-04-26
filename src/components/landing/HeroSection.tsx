"use client";

import { FormEvent, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

/** Route served by Next.js (same origin) — no cross-origin iframe issues. */
const PROXY_ROUTE = "/proxy";

const QUICK_LINKS = [
  { label: "DuckDuckGo",  url: "https://duckduckgo.com" },
  { label: "Wikipedia",   url: "https://wikipedia.org" },
  { label: "YouTube",     url: "https://youtube.com" },
  { label: "Reddit",      url: "https://reddit.com" },
  { label: "Twitter",     url: "https://twitter.com" },
];

export function HeroSection() {
  const [inputUrl, setInputUrl]   = useState("");
  const [proxyUrl, setProxyUrl]   = useState("");
  const [error, setError]         = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const iframeRef                 = useRef<HTMLIFrameElement>(null);
  const viewerRef                 = useRef<HTMLDivElement>(null);


  function normalizeUserUrl(value: string): string | null {
    const raw = value.trim();
    if (!raw) return null;
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try { return new URL(candidate).toString(); } catch { return null; }
  }

  function navigate(rawUrl: string) {
    setError("");
    const normalized = normalizeUserUrl(rawUrl);
    if (!normalized) {
      setProxyUrl("");
      setError("Please enter a valid website URL.");
      return;
    }
    setIsLoading(true);
    setInputUrl(rawUrl);
    // Use the same-origin Next.js route — avoids ALL cross-origin iframe issues.
    setProxyUrl(`${PROXY_ROUTE}?url=${encodeURIComponent(normalized)}`);
    setTimeout(() => viewerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    navigate(inputUrl);
  }

  function handleRefresh() {
    if (!proxyUrl) return;
    setIsLoading(true);
    if (iframeRef.current) {
      iframeRef.current.src = proxyUrl;
    }
  }

  function handleClear() {
    setProxyUrl("");
    setInputUrl("");
    setError("");
    setIsLoading(false);
  }

  return (
    <section className="hero-mesh relative overflow-hidden px-4 pb-12 pt-14 sm:px-6 lg:px-8 lg:pt-20">

      {/* Decorative blobs */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-20 -top-20 h-96 w-96 rounded-full bg-blue-400/10 blur-3xl" />
        <div className="absolute right-0 top-32 h-80 w-80 rounded-full bg-sky-300/15 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-indigo-300/10 blur-3xl" />
      </div>

      <div className="mx-auto w-full max-w-4xl">

        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-6 flex justify-center"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/80 px-4 py-1.5 text-xs font-semibold text-blue-600 shadow-sm backdrop-blur-sm">
            <ShieldCheck size={13} />
            Encrypted · Fast · Anonymous
          </span>
        </motion.div>

        {/* Headline */}
        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.08 }}
          className="text-center text-4xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl lg:text-6xl"
        >
          Browse the Web{" "}
          <span className="relative whitespace-nowrap">
            <span className="relative z-10 text-blue-600">Without Limits</span>
            <svg
              aria-hidden="true"
              className="absolute -bottom-1 left-0 w-full"
              viewBox="0 0 260 8"
              fill="none"
            >
              <path
                d="M2 6C50 2 120 1 258 5"
                stroke="#93c5fd"
                strokeWidth="3.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </motion.h1>

        {/* Subtext */}
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.15 }}
          className="mx-auto mt-5 max-w-2xl text-center text-base leading-7 text-slate-500 sm:text-lg"
        >
          ProxyHub lets you access any website instantly — secured, private, and
          free from geo‑restrictions.
        </motion.p>

        {/* Main search bar */}
        <motion.form
          onSubmit={handleSubmit}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.22 }}
          className="mt-8 flex items-center gap-2 rounded-2xl border border-blue-100 bg-white p-2 shadow-md shadow-blue-100/40 focus-within:ring-4 focus-within:ring-blue-100"
        >
          <div className="flex flex-1 items-center gap-2 px-2">
            <Search size={17} className="shrink-0 text-slate-400" />
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="Enter a URL or website address…"
              className="h-11 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
            />
            {inputUrl && (
              <button type="button" onClick={handleClear} className="shrink-0 text-slate-400 hover:text-slate-600">
                <X size={15} />
              </button>
            )}
          </div>
          <motion.button
            type="submit"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-300/50 transition-colors hover:bg-blue-700"
          >
            Go Proxy
            <ArrowRight size={15} />
          </motion.button>
        </motion.form>

        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 text-center text-sm text-red-500"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        {/* Quick links */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.32 }}
          className="mt-4 flex flex-wrap items-center justify-center gap-2"
        >
          <span className="text-xs text-slate-400">Quick access:</span>
          {QUICK_LINKS.map((link) => (
            <button
              key={link.label}
              type="button"
              onClick={() => navigate(link.url)}
              className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 hover:shadow"
            >
              {link.label}
            </button>
          ))}
        </motion.div>

        {/* Trust strip */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
        >
          {[
            { icon: ShieldCheck, text: "No logs kept" },
            { icon: Lock,        text: "TLS encrypted" },
            { icon: RefreshCw,   text: "Unlimited use" },
          ].map(({ icon: Icon, text }) => (
            <span key={text} className="flex items-center gap-1.5 text-xs text-slate-500">
              <Icon size={13} className="text-blue-500" />
              {text}
            </span>
          ))}
        </motion.div>
      </div>

      {/* ── Browser-chrome proxy viewer ── */}
      <AnimatePresence>
        {(proxyUrl || true) && (
          <motion.div
            ref={viewerRef}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: proxyUrl ? 0 : 0.5 }}
            className="mx-auto mt-10 w-full max-w-5xl"
          >
            {/* Window chrome */}
            <div className="rounded-t-2xl border border-slate-200 bg-slate-100 px-4 py-3">
              <div className="flex items-center gap-3">
                {/* Traffic-light dots */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-red-400" />
                  <div className="h-3 w-3 rounded-full bg-yellow-400" />
                  <div className="h-3 w-3 rounded-full bg-emerald-400" />
                </div>

                {/* URL bar */}
                <div className="flex flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
                  <Lock size={12} className="shrink-0 text-blue-500" />
                  <span className="flex-1 truncate text-xs text-slate-600">
                    {proxyUrl
                      ? proxyUrl
                      : "Proxy viewer — enter a URL above to begin"}
                  </span>
                </div>

                {/* Controls */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={handleRefresh}
                    disabled={!proxyUrl}
                    title="Refresh"
                    className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30"
                  >
                    <RefreshCw size={13} />
                  </button>
                  <button
                    onClick={handleClear}
                    disabled={!proxyUrl}
                    title="Close"
                    className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>

              {/* Loading progress bar */}
              <AnimatePresence>
                {isLoading && (
                  <motion.div
                    key="progress"
                    className="mt-2 h-0.5 overflow-hidden rounded-full bg-slate-200"
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <div className="animate-progress h-full bg-blue-500" />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* iframe body */}
            <div className="overflow-hidden rounded-b-2xl border-x border-b border-slate-200 bg-white shadow-lg shadow-slate-200/60">
              {proxyUrl ? (
                <iframe
                  ref={iframeRef}
                  title="Proxy content viewer"
                  src={proxyUrl}
                  className="h-[540px] w-full"
                  onLoad={() => setIsLoading(false)}
                />
              ) : (
                <div className="grid h-[360px] place-items-center bg-slate-50">
                  <div className="text-center">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-500">
                      <Search size={28} />
                    </div>
                    <p className="text-sm font-medium text-slate-700">
                      Your proxy window is ready
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Enter a URL above to load any website securely.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
