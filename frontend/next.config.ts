import type { NextConfig } from "next";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);

// Resolve note-collector sub-exports manually — webpack can't resolve
// package.json "exports" for file:-symlinked packages
const noteCollectorDest = path.resolve(
  import.meta.dirname,
  "../../aztec-packages/yarn-project/note-collector/dest/client"
);

const nextConfig: NextConfig = {
  turbopack: {
    // Extend root to include aztec-packages so Turbopack can resolve
    // file:-linked dependencies outside the default project root
    root: path.resolve(import.meta.dirname, "../.."),
  },
  webpack: (config, { isServer, webpack }) => {
    // Resolve note-collector sub-exports for both client and SSR builds
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@aztec/note-collector/client/wallet": path.join(noteCollectorDest, "auditable_wallet.js"),
      "@aztec/note-collector/client/browser": path.join(noteCollectorDest, "auditable_pxe_browser.js"),
      "@proof": path.resolve(import.meta.dirname, "../src"),
    };

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
