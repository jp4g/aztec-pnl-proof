This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Deploy to Vercel

The project uses local `file:` dependencies on `aztec-packages`, so it must be built locally and deployed as pre-built output.

### One-time setup

1. Install Vercel CLI: `npm i -g vercel`
2. Link the project: `vercel link` (set root directory to `.`)
3. Set the runtime env var:
   ```bash
   vercel env add NEXT_PUBLIC_AZTEC_NODE_URL
   # Value: https://v4-devnet-2.aztec-labs.com
   ```

### Deploy

```bash
vercel build --prod
node scripts/patch-vercel-output.mjs
vercel deploy --prebuilt --prod
```

Or use the shortcut: `yarn deploy:prod`

The patch script copies the API route bundle into the serverless function directory — Vercel's file tracing can't follow symlinked dependencies outside the project root.

## Known Issues

### Client-side proving disabled (`proverEnabled: false`)

Client-side ClientIVC proving via `BBLazyPrivateKernelProver` is currently disabled. The BB WASM worker throws `ReferenceError: window is not defined` because Next.js webpack bundles modules into the Web Worker that reference `window` directly (Web Workers only have `self`/`globalThis`, not `window`).

The sandbox accepts unproven transactions in dev mode, so this doesn't block development. To fix:
- Investigate which module in the BB WASM worker bundle has an unguarded `window` reference
- May need a webpack worker plugin or custom worker configuration to polyfill/stub `window` in the worker context
- Alternatively, configure Barretenberg to use the non-worker WASM backend (`BackendType.Wasm`) which runs on the main thread
