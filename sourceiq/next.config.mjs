/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native Node.js addons (vectordb/LanceDB, better-sqlite3) cannot be bundled by webpack.
  // Mark them as external so Next.js requires them at runtime instead.
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        'vectordb',
        'better-sqlite3',
        '@xenova/transformers',
        'foundry-local-sdk',  // ESM + native FFI (.dll via koffi) — must not be bundled
        'koffi',              // native FFI runtime dep of foundry-local-sdk
        'sharp',              // native image addon used by @xenova/transformers (text-only mode)
      ];
    }
    return config;
  },
};

export default nextConfig;
