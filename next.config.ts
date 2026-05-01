import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow Next.js route handlers to return large proxied pages (up to 20 MB).
  experimental: {
    reactCompiler: true,
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
