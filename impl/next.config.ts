import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Keep Next from treating the repo-level RuleSync lockfile as this app's root.
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ["ws", "@solana/zk-sdk"],
  // @solana/kit-plugin-signer's browser bundle has a spurious `import 'fs'`
  // from the *FromFile exports. Stub it out for the client bundle.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./empty-module.js" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
};

export default nextConfig;
