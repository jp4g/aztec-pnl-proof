import type { NextConfig } from "next";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const nextConfig: NextConfig = {
  // Empty turbopack config to suppress the warning when using webpack
  turbopack: {},
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
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
