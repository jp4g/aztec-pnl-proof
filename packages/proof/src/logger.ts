const enabled = typeof process !== 'undefined' && !!process.env.DEBUG;

export const log = enabled ? console.log.bind(console) : () => {};
export const warn = enabled ? console.warn.bind(console) : () => {};
export const error = enabled ? console.error.bind(console) : () => {};
