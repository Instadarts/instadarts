import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export interface EmbeddedAsset {
  contentType: string;
  data: Buffer;
  etag: string;
}

import { EMBEDDED_CLIENT_BUNDLE } from './embeddedAssetsBundle';
export { EMBEDDED_CLIENT_BUNDLE };

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
};

export function getMimeType(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return 'application/octet-stream';
  const ext = filePath.slice(dotIndex).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

let cachedAssets: Map<string, EmbeddedAsset> | null = null;

/**
 * Decompresses and indexes the embedded client bundle if present.
 * Cached in memory so decompression happens only once at startup.
 */
export function getEmbeddedAssets(bundle: string | null = EMBEDDED_CLIENT_BUNDLE): Map<string, EmbeddedAsset> | null {
  if (bundle === EMBEDDED_CLIENT_BUNDLE && cachedAssets) return cachedAssets;
  if (!bundle) return null;

  try {
    const compressed = Buffer.from(bundle, 'base64');
    const decompressed = gunzipSync(compressed);
    const rawMap: Record<string, string> = JSON.parse(decompressed.toString('utf-8'));

    const assets = new Map<string, EmbeddedAsset>();
    for (const [path, base64Content] of Object.entries(rawMap)) {
      const data = Buffer.from(base64Content, 'base64');
      const hash = createHash('sha1').update(data).digest('hex').slice(0, 16);
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      assets.set(normalizedPath, {
        contentType: getMimeType(normalizedPath),
        data,
        etag: `"${hash}"`,
      });
    }

    cachedAssets = assets;
    return assets;
  } catch (err) {
    console.error('Failed to unpack embedded client assets:', err);
    return null;
  }
}
