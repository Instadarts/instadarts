/** Sources accepted by the vision pipeline. */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

export interface FrameCrop {
  sourceWidth: number;
  sourceHeight: number;
  cropX: number;
  cropY: number;
  cropSize: number;
}

/**
 * How a source is framed before its uniform resize to the model's square input.
 *
 * Live camera frames use the centre square because browsers may ignore our square capture request.
 * Reference photographs use the whole image: those assets are required to be square, so a changed
 * asset can never be silently cropped or squeezed into appearing valid.
 */
export type ModelInputFraming = 'center-square' | 'whole-square';

export function getSourceDimensions(source: FrameSource): { width: number; height: number } {
  // Each source kind names its dimensions differently and they do not share a useful base type.
  const any = source as {
    videoWidth?: number;
    displayWidth?: number;
    width?: number;
    videoHeight?: number;
    displayHeight?: number;
    height?: number;
  };
  const width = any.videoWidth || any.displayWidth || any.width || 0;
  const height = any.videoHeight || any.displayHeight || any.height || 0;
  if (!width || !height) throw new Error('Invalid source dimensions');
  return { width, height };
}

/** The one crop used by live inference, motion, calibration, stills, and the square preview. */
export function getCenterSquareCrop(source: FrameSource): FrameCrop {
  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(source);
  const cropSize = Math.min(sourceWidth, sourceHeight);
  return {
    sourceWidth,
    sourceHeight,
    cropX: Math.max(0, Math.floor((sourceWidth - cropSize) / 2)),
    cropY: Math.max(0, Math.floor((sourceHeight - cropSize) / 2)),
    cropSize,
  };
}

/** Resolve the source rectangle without allowing the whole-image path to alter its framing. */
export function getModelInputCrop(source: FrameSource, framing: ModelInputFraming): FrameCrop {
  if (framing === 'center-square') return getCenterSquareCrop(source);

  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(source);
  if (sourceWidth !== sourceHeight) {
    throw new Error(
      `Whole-image model input must be square; received ${sourceWidth}x${sourceHeight}`,
    );
  }
  return {
    sourceWidth,
    sourceHeight,
    cropX: 0,
    cropY: 0,
    cropSize: sourceWidth,
  };
}
