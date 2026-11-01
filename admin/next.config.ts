import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Pinned because this app sits inside the main project's directory tree: without
// it Next walks up, finds the parent lockfile, and treats that as the root.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
