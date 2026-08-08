// Camera capture: opening one, remembering which, and holding its zoom.
//
// The constraints and the clamping were arrived at against real phones, so treat the numbers as
// measurements rather than preferences. A camera is remembered by **label** and not by deviceId,
// because deviceId is not stable across sessions.
//
// The storage keys are the scorer's own, so this app and the gaming frontend can share a browser
// without overwriting each other.

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
  zoomRange(): ZoomRange | null;
  applyZoom(value: number): Promise<number | null>;
  storedZoom(): number | null;
  readonly active: boolean;
  readonly label: string;
  readonly settings: MediaTrackSettings;
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

/** Whether the platform knows a constraint at all — the same non-standard set as above. */
function supports(constraint: 'focusMode'): boolean {
  return constraint in navigator.mediaDevices.getSupportedConstraints();
}

const STORE_ZOOMS = 'instadarts_scorer_zooms';
const STORE_LAST_CAMERA = 'instadarts_scorer_last_camera';

/**
 * Square capture at the model's input size, 15fps, continuous autofocus where supported.
 * crop-and-scale keeps the sensor's centre square rather than letterboxing.
 */
export function buildCameraConstraints(inputSize: number): MediaStreamConstraints {
  const video: ScorerVideoConstraints = {
      width: { ideal: inputSize },
      height: { ideal: inputSize },
      frameRate: { ideal: 15 },
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

/** deviceId is not stable across sessions, so the remembered camera is matched by label. */
export function rememberCamera(label: string): void {
  try { window.localStorage.setItem(STORE_LAST_CAMERA, label); } catch { /* private mode */ }
}

export function preferredCamera(cameras: CameraChoice[]): CameraChoice | null {
  let last = '';
  try { last = window.localStorage.getItem(STORE_LAST_CAMERA) || ''; } catch { /* private mode */ }
  return cameras.find((c) => c.label === last) ?? cameras[0] ?? null;
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
    rememberCamera(label);
    video.srcObject = stream;
    await video.play().catch(() => { /* autoplay policies; the preview still fills in */ });
    return { label, settings: track?.getSettings?.() ?? {} };
  }

  function stop() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    video.srcObject = null;
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
    storeZoom(label, clamped);
    return clamped;
  }

  function storedZoom(): number | null {
    try {
      const all = JSON.parse(window.localStorage.getItem(STORE_ZOOMS) || '{}');
      return typeof all[label] === 'number' ? all[label] : null;
    } catch { return null; }
  }

  function storeZoom(cameraLabel: string, value: number): void {
    try {
      const all = JSON.parse(window.localStorage.getItem(STORE_ZOOMS) || '{}');
      all[cameraLabel] = value;
      window.localStorage.setItem(STORE_ZOOMS, JSON.stringify(all));
    } catch { /* private mode */ }
  }

  return {
    start,
    stop,
    zoomRange,
    applyZoom,
    storedZoom,
    get active() { return !!stream; },
    get label() { return label; },
    get settings() { return track?.getSettings?.() ?? {}; },
  };
}
