import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["draco3dgltf"],
  outputFileTracingIncludes: { "/*": ["./node_modules/draco3dgltf/**/*"] },
  // Private session reads and Node-only preparation use ordinary dynamic routes.
  cacheComponents: false,
};

export default nextConfig;
