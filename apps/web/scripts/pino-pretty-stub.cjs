// Stub for pino-pretty in serverless bundles.
// pino's transport system tries to load pino-pretty via worker_threads,
// which fails in webpack bundles. This stub prevents the crash.
module.exports = {};
