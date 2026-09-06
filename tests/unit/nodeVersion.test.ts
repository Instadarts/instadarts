import { describe, it, expect, vi } from 'vitest';
import { isSupportedNodeVersion, enforceNodeVersion, MIN_NODE_VERSION } from '../../src/server/nodeVersion';

describe('Node version check', () => {
  it('identifies Node 22.22.0+ as supported', () => {
    expect(isSupportedNodeVersion('22.22.0')).toBe(true);
    expect(isSupportedNodeVersion('22.22.1')).toBe(true);
    expect(isSupportedNodeVersion('23.0.0')).toBe(true);
    expect(isSupportedNodeVersion('24.1.0')).toBe(true);
  });

  it('identifies Node < 22.22.0 as unsupported', () => {
    expect(isSupportedNodeVersion('22.0.0')).toBe(false);
    expect(isSupportedNodeVersion('22.21.1')).toBe(false);
    expect(isSupportedNodeVersion('16.0.0')).toBe(false);
    expect(isSupportedNodeVersion('')).toBe(false);
    expect(isSupportedNodeVersion('invalid')).toBe(false);
  });

  it('exits with code 1 and logs error on unsupported version', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never));

    enforceNodeVersion('20.0.0');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`InstaDarts requires Node.js ${MIN_NODE_VERSION} or later`),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does not exit on supported version', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never));

    enforceNodeVersion('22.22.0');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
