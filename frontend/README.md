This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Known Issues

### Client-side proving disabled (`proverEnabled: false`)

Client-side ClientIVC proving via `BBLazyPrivateKernelProver` is currently disabled. The BB WASM worker throws `ReferenceError: window is not defined` because Next.js webpack bundles modules into the Web Worker that reference `window` directly (Web Workers only have `self`/`globalThis`, not `window`).

The sandbox accepts unproven transactions in dev mode, so this doesn't block development. To fix:
- Investigate which module in the BB WASM worker bundle has an unguarded `window` reference
- May need a webpack worker plugin or custom worker configuration to polyfill/stub `window` in the worker context
- Alternatively, configure Barretenberg to use the non-worker WASM backend (`BackendType.Wasm`) which runs on the main thread
