import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS folder. A stray package-lock.json in the
  // home dir otherwise confuses Next's root inference and file tracing.
  turbopack: { root: __dirname },
};

export default nextConfig;
