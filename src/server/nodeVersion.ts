/**
 * Minimum required Node.js major version.
 *
 * The server relies on Node 22+ features (native ESM, modern Web/networking APIs).
 * Refuse to start early with a clear, readable error if launched on an older Node version.
 */
export const MIN_NODE_MAJOR = 22;

export function isSupportedNodeVersion(versionString: string = process.versions.node): boolean {
  const major = parseInt(versionString.split('.')[0], 10);
  return !Number.isNaN(major) && major >= MIN_NODE_MAJOR;
}

export function enforceNodeVersion(versionString: string = process.versions.node): void {
  if (!isSupportedNodeVersion(versionString)) {
    console.error(
      `InstaDarts requires Node.js ${MIN_NODE_MAJOR} or later (currently running on Node.js ${process.version || `v${versionString}`}).`,
    );
    process.exit(1);
  }
}

// Enforce immediately when imported
enforceNodeVersion();
