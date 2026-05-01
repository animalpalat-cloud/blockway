const nextConfig = {
  // دیگر کنفیگریشن...
  experimental: {
    // reactCompiler: true, <-- اس لائن کو ختم کر دیں
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;