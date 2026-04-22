import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "160mb",
    },
  },
  // Prevent Next.js from bundling pdfjs-dist and @napi-rs/canvas into server chunks.
  // These packages must be loaded via require() from node_modules directly so that
  // pdfjs's worker-file path resolution works correctly on the server.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
