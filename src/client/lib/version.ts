/**
 * The running build's version, as `0.1.0`.
 *
 * One named export rather than the raw constant at every call site, so that the places showing it
 * are found by their import and the Vite substitution is explained in exactly one place.
 */
export const APP_VERSION = __APP_VERSION__;
