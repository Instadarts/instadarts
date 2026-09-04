import { describe, expect, it } from 'vitest';
import { getCenterSquareCrop, getModelInputCrop, type FrameSource } from '../../src/client/vision/frame';

const source = (width: number, height: number) => ({ width, height }) as FrameSource;

describe('vision frame geometry', () => {
  it('takes the centred 720-pixel square from a 1280x720 camera frame', () => {
    expect(getCenterSquareCrop(source(1280, 720))).toEqual({
      sourceWidth: 1280,
      sourceHeight: 720,
      cropX: 280,
      cropY: 0,
      cropSize: 720,
    });
  });

  it('centres the crop on portrait streams as well', () => {
    expect(getCenterSquareCrop(source(720, 1280))).toMatchObject({
      cropX: 0,
      cropY: 280,
      cropSize: 720,
    });
  });

  it('uses a whole square validation image without cropping it', () => {
    expect(getModelInputCrop(source(1280, 1280), 'whole-square')).toEqual({
      sourceWidth: 1280,
      sourceHeight: 1280,
      cropX: 0,
      cropY: 0,
      cropSize: 1280,
    });
  });

  it('rejects a non-square validation image instead of cropping or squeezing it', () => {
    expect(() => getModelInputCrop(source(1280, 720), 'whole-square'))
      .toThrow(/must be square.*1280x720/i);
  });
});
