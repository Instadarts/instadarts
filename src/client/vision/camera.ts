// Camera capture: opening one, remembering which, and holding its zoom.
//
// The constraints and the clamping were arrived at against real phones, so treat the numbers as
// measurements rather than preferences. A camera is remembered by **label** and not by deviceId,
// because deviceId is not stable across sessions.
//
// What is remembered lives in the scorer's settings rather than in keys of this module's own. The
// choice and its zoom are things a person made, sitting beside the lens calibration that is keyed
// the same way — and putting them there is what lets `resetSettings` clear them when somebody asks
// to set this phone up again.

import { cameraFrameRate } from '../lib/appConfig';
import { loadSettings, saveSettings, setZoomForCamera, zoomForCamera } from '../lib/scorerStorage';

/** One camera the browser will let us open. */
export interface CameraChoice {
  deviceId: string;
  label: string;
}

/** What the platform will let us do with zoom, where it exposes it at all. */
export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export interface Camera {
  start(deviceId: string, inputSize: number): Promise<{ label: string; settings: MediaTrackSettings }>;
  stop(): void;
  maximumShortSide(): number | null;
  zoomRange(): ZoomRange | null;
  applyZoom(value: number): Promise<number | null>;
  storedZoom(): number | null;
  readonly active: boolean;
  readonly label: string;
  readonly settings: MediaTrackSettings;
}

/**
 * Wait until an opened stream has produced a real picture.
 *
 * `play()` resolving only says playback started. Motion analysis and inference both need non-zero
 * frame dimensions, so letting camera startup finish before this point turns the first automatic
 * pass into a race against the device. The timeout makes a camera that opened but never delivers a
 * frame an actionable error instead of an indefinitely unprimed scorer.
 */
export function waitForCameraFrame(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The camera opened but sent no picture.'));
    }, 5000);
    const done = () => {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('timeupdate', done);
    };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('timeupdate', done);
  });
}

/**
 * Constraints the browser does not agree on.
 *
 * `resizeMode`, `focusMode` and `zoom` are all real and all useful — sharp, square, centre-cropped
 * frames are what the model wants — but none of them is in the standard `MediaTrackConstraintSet`,
 * so they are declared here rather than cast away at each use.
 */
interface ScorerVideoConstraints extends MediaTrackConstraints {
  resizeMode?: string;
  focusMode?: { ideal: string };
  deviceId?: { exact: string };
}

interface ScorerCapabilities extends MediaTrackCapabilities {
  zoom?: { min: number; max: number; step?: number };
}

/** Maximum usable square side advertised by a track, or unknown where the browser omits it. */
export function maximumCameraShortSide(capabilities: MediaTrackCapabilities | undefined): number | null {
  const caps = capabilities as (ScorerCapabilities & {
    width?: { max?: number };
    height?: { max?: number };
  }) | undefined;
  const width = Number(caps?.width?.max);
  const height = Number(caps?.height?.max);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  return Math.min(width, height);
}

/** Whether the platform knows a constraint at all — the same non-standard set as above. */
function supports(constraint: 'focusMode'): boolean {
  return constraint in (navigator.mediaDevices?.getSupportedConstraints?.() ?? {});
}

/**
 * Prefer square capture at the model's input size, at the configured frame rate, with continuous
 * autofocus where supported. These are ideals: cameras commonly return a landscape mode instead.
 * Every vision consumer therefore applies the same centre-square crop in software as the fallback.
 */
export function buildCameraConstraints(inputSize: number): MediaStreamConstraints {
  const video: ScorerVideoConstraints = {
      width: { ideal: inputSize },
      height: { ideal: inputSize },
      aspectRatio: { ideal: 1 },
      frameRate: { ideal: cameraFrameRate() },
      resizeMode: 'crop-and-scale',
      ...(supports('focusMode') ? { focusMode: { ideal: 'continuous' } } : {}),
  };
  return { video, audio: false };
}

/**
 * List cameras. Needs a permission probe first: labels are empty until the user has granted
 * camera access at least once.
 */
export async function listCameras(): Promise<CameraChoice[]> {
  const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  probe.getTracks().forEach((t) => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/**
 * How a phone names the camera on its back. Both spellings are in the wild: iOS says "Back Camera",
 * Android's `camera2` labels say "facing back", and some desktop and tablet firmware says "rear".
 */
const BACK_CAMERA = /\b(back|rear)\b/i;

/**
 * The camera to open, matched by label — see `ScorerSettings.camera` for why not by deviceId.
 *
 * A stored choice always wins. With none, the back camera is the better guess than the first in the
 * list: a phone on a mount is pointed at the board with its back, and the browser tends to enumerate
 * the selfie camera first. **Only when exactly one camera says so** — a handset that reports a wide
 * and an ultra-wide rear lens is asking a question this cannot answer, so it falls through to the
 * first and lets somebody pick in setup.
 */
export function preferredCamera(cameras: CameraChoice[]): CameraChoice | null {
  const chosen = loadSettings().camera;
  const stored = cameras.find((c) => c.label === chosen);
  if (stored) return stored;

  const backs = cameras.filter((c) => BACK_CAMERA.test(c.label));
  return (backs.length === 1 ? backs[0] : null) ?? cameras[0] ?? null;
}

export function createCamera({ video }: { video: HTMLVideoElement }): Camera {
  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  let label = '';

  async function start(deviceId: string, inputSize: number) {
    stop();
    const constraints = buildCameraConstraints(inputSize);
    (constraints.video as ScorerVideoConstraints).deviceId = { exact: deviceId };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    track = stream.getVideoTracks()[0] ?? null;
    // "detail" asks the encoder to favour sharpness over smoothness — dart tips are small.
    if (track) track.contentHint = 'detail';
    label = track?.label ?? '';
    // Remembered here rather than by whoever picked, so every route to an open camera — the picker,
    // the preferred one at boot, a restart for a bigger model — leaves the same answer behind.
    saveSettings({ camera: label });
    video.srcObject = stream;
    await video.play().catch(() => { /* autoplay policies; the preview still fills in */ });
    try {
      await waitForCameraFrame(video);
    } catch (error) {
      stop();
      throw error;
    }
    return { label, settings: track?.getSettings?.() ?? {} };
  }

  function stop() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    video.srcObject = null;
  }

  /** Largest square the selected track advertises, independent of the currently requested mode. */
  function maximumShortSide(): number | null {
    return maximumCameraShortSide(track?.getCapabilities?.());
  }

  /** Zoom range if the platform exposes it (Android Chrome does; iOS Safari mostly does not). */
  function zoomRange(): ZoomRange | null {
    const caps = track?.getCapabilities?.() as ScorerCapabilities | undefined;
    if (!caps || !caps.zoom) return null;
    return { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
  }

  async function applyZoom(value: number): Promise<number | null> {
    const range = zoomRange();
    if (!range || !track) return null;
    const clamped = Math.min(Math.max(Number(value), range.min), range.max);
    await track.applyConstraints({ advanced: [{ zoom: clamped } as MediaTrackConstraintSet] });
    setZoomForCamera(label, clamped);
    return clamped;
  }

  function storedZoom(): number | null {
    return zoomForCamera(loadSettings(), label);
  }

  return {
    start,
    stop,
    maximumShortSide,
    zoomRange,
    applyZoom,
    storedZoom,
    get active() { return !!stream; },
    get label() { return label; },
    get settings() { return track?.getSettings?.() ?? {}; },
  };
}
