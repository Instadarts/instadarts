/**
 * Minimum required Node.js version, matching package.json and React Router's requirement.
 *
 * Refuse to start early with a clear, readable error if launched on an older Node version.
 */
export const MIN_NODE_VERSION = '22.22.0';
const [MIN_NODE_MAJOR, MIN_NODE_MINOR] = MIN_NODE_VERSION.split('.').map(Number);

export function isSupportedNodeVersion(versionString: string = process.versions.node): boolean {
  const [major, minor] = versionString.split('.').map(Number);
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

export function enforceNodeVersion(versionString: string = process.versions.node): void {
  if (!isSupportedNodeVersion(versionString)) {
    console.error(
      `InstaDarts requires Node.js ${MIN_NODE_VERSION} or later (currently running on Node.js ${process.version || `v${versionString}`}).`,
    );
    process.exit(1);
  }
}

// Enforce immediately when imported
enforceNodeVersion();
