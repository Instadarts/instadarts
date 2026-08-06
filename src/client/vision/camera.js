// Camera capture, ported from dartszentrale-ai-scorer src/vision/camera.js.
//
// The constraints, the label-based camera memory, the zoom clamping and the per-camera zoom store
// are unchanged: they were arrived at against real phones. Only the storage keys differ, so that
// this app and the gaming frontend can share a browser without overwriting each other.

const STORE_ZOOMS = 'instadarts_scorer_zooms';
const STORE_LAST_CAMERA = 'instadarts_scorer_last_camera';

/**
 * Square capture at the model's input size, 15fps, continuous autofocus where supported.
 * crop-and-scale keeps the sensor's centre square rather than letterboxing.
 */
export function buildCameraConstraints(inputSize) {
  return {
    video: {
      width: { ideal: inputSize },
      height: { ideal: inputSize },
      frameRate: { ideal: 15 },
      resizeMode: 'crop-and-scale',
      ...(typeof MediaTrackSupportedConstraints !== 'undefined' &&
        navigator.mediaDevices.getSupportedConstraints().focusMode
        ? { focusMode: { ideal: 'continuous' } }
        : {}),
    },
    audio: false,
  };
}

/**
 * List cameras. Needs a permission probe first: labels are empty until the user has granted
 * camera access at least once.
 */
export async function listCameras() {
  const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  probe.getTracks().forEach((t) => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** deviceId is not stable across sessions, so the remembered camera is matched by label. */
export function rememberCamera(label) {
  try { window.localStorage.setItem(STORE_LAST_CAMERA, label); } catch { /* private mode */ }
}

export function preferredCamera(cameras) {
  let last = '';
  try { last = window.localStorage.getItem(STORE_LAST_CAMERA) || ''; } catch { /* private mode */ }
  return cameras.find((c) => c.label === last) ?? cameras[0] ?? null;
}

export function createCamera({ video }) {
  let stream = null;
  let track = null;
  let label = '';

  async function start(deviceId, inputSize) {
    stop();
    const constraints = buildCameraConstraints(inputSize);
    constraints.video.deviceId = { exact: deviceId };
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
  function zoomRange() {
    const caps = track?.getCapabilities?.();
    if (!caps || !caps.zoom) return null;
    return { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
  }

  async function applyZoom(value) {
    const range = zoomRange();
    if (!range || !track) return null;
    const clamped = Math.min(Math.max(Number(value), range.min), range.max);
    await track.applyConstraints({ advanced: [{ zoom: clamped }] });
    storeZoom(label, clamped);
    return clamped;
  }

  function storedZoom() {
    try {
      const all = JSON.parse(window.localStorage.getItem(STORE_ZOOMS) || '{}');
      return typeof all[label] === 'number' ? all[label] : null;
    } catch { return null; }
  }

  function storeZoom(cameraLabel, value) {
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
