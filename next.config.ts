import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  experimental: {
    serverActions: {
      bodySizeLimit: "32mb",   // match PROXY_MAX_SIZE_MB
    },
  },

  // Increase response body size limit for the proxy route
  // (Next.js 14+ route handlers stream, but we buffer)
  serverExternalPackages: ["puppeteer-core", "chrome-aws-lambda"],

  async headers() {
    return [
      {
        // Proxy route — allow all origins, prevent caching
        source: "/proxy",
        headers: [
          { key: "Access-Control-Allow-Origin",  value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, HEAD, PUT, PATCH, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, User-Agent, Cookie, Range, X-Requested-With, Origin, Referer" },
          { key: "Cache-Control",                value: "no-store, no-cache, must-revalidate, private" },
          { key: "X-Content-Type-Options",       value: "nosniff" },
        ],
      },
      {
        // Service worker — must have no-cache so updates are detected
        source: "/sw.js",
        headers: [
          { key: "Cache-Control",     value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type",      value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/pwa.js",
        headers: [
          { key: "Cache-Control",     value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type",      value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },

  // Allow the proxy to fetch from any external domain
  async rewrites() {
    return [];
  },
};

export default nextConfig;
