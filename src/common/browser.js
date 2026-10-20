// Chrome exposes `chrome`, Firefox exposes both `browser` and `chrome`.
// Both support promise-returning extension APIs in MV3, so a plain alias is
// enough and avoids pulling in a polyfill.
export const ext = globalThis.browser ?? globalThis.chrome;

export const IS_FIREFOX = typeof globalThis.browser !== "undefined" && !!globalThis.browser.runtime;
