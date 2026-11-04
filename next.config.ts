import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Web app uses its own tsconfig; the root tsconfig.json keeps the Node/editorial context.
  typescript: { tsconfigPath: "tsconfig.web.json" },
  poweredByHeader: false,
  // `next dev` would otherwise append a generated block to the project's AGENTS.md.
  agentRules: false,
};

export default nextConfig;
