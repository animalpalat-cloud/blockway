// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "32mb",
    },
  },

  serverExternalPackages: ["puppeteer-core", "chrome-aws-lambda"],

  async headers() {
    return [
      {
        source: "/proxy",
        headers: [
          { key: "Access-Control-Allow-Origin",  value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, HEAD, PUT, PATCH, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Accept, Authorization, User-Agent, Cookie, Range, X-Requested-With, Origin, Referer" },
          { key: "Cache-Control",                value: "no-store, no-cache, must-revalidate, private" },
        ],
      },
      {
        source: "/subdomain-proxy",
        headers: [
          { key: "Access-Control-Allow-Origin",  value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, HEAD, PUT, PATCH, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Accept, Authorization, User-Agent, Cookie, Range, X-Requested-With, Origin, Referer" },
          { key: "Cache-Control",                value: "no-store, no-cache, must-revalidate, private" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control",          value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type",           value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/pwa.js",
        headers: [
          { key: "Cache-Control",          value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type",           value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },

  async rewrites() {
    return [];
  },
};

export default nextConfig;
