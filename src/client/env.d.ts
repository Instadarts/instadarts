/**
 * Build-time constants Vite substitutes into the client bundle. See `define` in vite.config.ts.
 *
 * A declaration and not a module, because the substitution happens in the bundler: the identifier
 * has to exist for TypeScript without existing at runtime for anything but Vite to replace.
 */

/** The application's version, taken from package.json when the bundle was built. */
declare const __APP_VERSION__: string;
