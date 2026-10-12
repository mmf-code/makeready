import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["draco3dgltf"],
  outputFileTracingIncludes: { "/*": ["./node_modules/draco3dgltf/**/*"] },
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
