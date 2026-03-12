import type { NextConfig } from "next";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
  turbopack: {},
  transpilePackages: ['@privpnl/proof', '@privpnl/contracts', '@privpnl/circuits'],
  webpack: (config, { isServer, webpack }) => {
    config.resolve = config.resolve ?? {};

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        // Polyfilled
        buffer: require.resolve("buffer/"),
        util: require.resolve("util/"),
        assert: require.resolve("assert/"),
        events: require.resolve("events/"),
        stream: require.resolve("stream-browserify"),
        string_decoder: require.resolve("string_decoder/"),
        // Not needed in browser
        crypto: false,
        fs: false,
        os: false,
        path: false,
        tty: false,
        url: false,
        net: false,
        worker_threads: false,
      };

      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
        }),
        // Polyfill `window` in Web Worker contexts — BB WASM workers reference
        // `window` which doesn't exist in workers (only `self`/`globalThis`).
        new webpack.BannerPlugin({
          banner: 'if(typeof window==="undefined"){globalThis.window=globalThis;}',
          raw: true,
          entryOnly: false,
          test: /\.js$/,
        })
      );
    }

    // Exclude WASM files from webpack processing - they are loaded at runtime by the browser
    config.module = config.module ?? {};
    config.module.rules = config.module.rules ?? [];
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });

    return config;
  },
};

export default nextConfig;
