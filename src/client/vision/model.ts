// The model runner: WebGPU first, WASM CPU as the fallback.
//
// LiteRT (@litertjs/core) executes the .tflite; everything around it here is getting one square
// RGB frame into a tensor as cheaply as possible, because that preprocessing is what a phone
// actually spends its battery on. Two paths do it: a compute shader that samples the video texture
// straight into the tensor buffer, and a canvas-and-CPU path for machines without WebGPU.
//
// The numbers here — the thread cap, the workgroup size, the tensor reuse — are measurements, not
// preferences. Do not "clean up" this file without a benchmark on a real phone.

import { getWebGpuDevice, setWebGpuDevice, isWebGPUSupported, loadLiteRt, loadAndCompile, Tensor } from '@litertjs/core';


/** A source the pipeline can read a frame from. */
type FrameSource = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

/** A canvas of either kind, since OffscreenCanvas is used where the platform has it. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCanvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * What LiteRT hands back, plus the container it hands them back in.
 *
 * The runtime checks below (`typeof x.delete === "function"`) are older than these types and are
 * kept: LiteRT's shape has changed across versions, and a missing method here means a leaked GPU
 * buffer rather than an exception.
 */
type TensorList = Tensor[] & { delete?: () => void };

/** One inference, however it was executed. */
export interface RunResult {
  outputs: ArrayLike<number>[];
  modelMs: number;
  preprocessMode: string;
}

/**
 * A loaded model, ready to run. The two runners below — WebGPU and WASM — are interchangeable
 * behind this, which is what lets the pipeline above not care which one it got.
 */
export interface ModelRunner {
  accelerator: string;
  isFullyAccelerated?: unknown;
  inputDetails?: unknown;
  outputDetails?: unknown;
  webGpuError?: unknown;
  run(sourceFrame: FrameSource, inputSize: number, options?: RunOptions): Promise<RunResult>;
  delete(): void;
}

export interface RunOptions {
  forceCpuPreprocessing?: boolean;
}

const LITERT_WASM_PATH = '/wasm/';

// Cap on threads used by the WASM CPU backend during inference. LiteRT otherwise
// defaults to navigator.hardwareConcurrency (e.g. 32 on a 16c/32t desktop), and
// past a handful of threads a small model gains little while contention grows —
// on phones fewer threads also means less heat/battery. This limits threads
// *used*, not the worker pool the threaded build pre-spawns (that tracks
// hardwareConcurrency and isn't exposed by LiteRT). null = use LiteRT's default.
const WASM_MAX_THREADS = 4;
const ENABLE_WEBGPU_PREPROCESSING = true;
const WEBGPU_PREPROCESS_WORKGROUP_SIZE = 16;
const WEBGPU_PREPROCESS_SHADER = `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<storage, read_write> outputBuffer: array<f32>;

struct Params {
  outputSize: u32,
  pixelCount: u32,
};

@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(${WEBGPU_PREPROCESS_WORKGROUP_SIZE}, ${WEBGPU_PREPROCESS_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.outputSize || id.y >= params.outputSize) {
    return;
  }

  let outputSizeF = f32(params.outputSize);
  let uv = (vec2<f32>(f32(id.x), f32(id.y)) + vec2<f32>(0.5, 0.5)) / outputSizeF;
  let rgba = textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0);
  let outputIndex = id.y * params.outputSize + id.x;

  outputBuffer[outputIndex] = rgba.r;
  outputBuffer[params.pixelCount + outputIndex] = rgba.g;
  outputBuffer[(params.pixelCount * 2u) + outputIndex] = rgba.b;
}
`;

let liteRtReady = false;
let liteRtPromise: Promise<void> | null = null;

export async function ensureLiteRtReady() {
  if (liteRtReady) return;
  if (!liteRtPromise) {
    liteRtPromise = loadLiteRtWithBestCpuBackend()
      .then(ensureWebGpuDevice)
      .then(() => {
        liteRtReady = true;
      });
  }
  return liteRtPromise;
}

/**
 * Make sure LiteRT has a WebGPU device, supplying one of our own if it has none.
 *
 * **Everything with a GPU path asks LiteRT for the device rather than making its own** — the
 * preprocessing shader here, and the motion detector's analyzer in motion.ts. So when LiteRT's own
 * `createDefaultWebGpuDevice` comes back empty, three separate features silently lose their GPU
 * path at once and each of them reports it as its own failure.
 *
 * Only ever *adds* a device, never replaces a working one: where LiteRT already has one, everything
 * downstream is exactly as it was. That matters because LiteRT asks its adapter for whatever limits
 * and features its own inference wants, and a plainer device of ours could be worse. Where it has
 * none, there was no GPU path to lose.
 *
 * Must happen before the first `loadAndCompile`: `setWebGpuDevice` replaces the default
 * *environment*, and a model compiled into the old one does not belong to the new one.
 */
async function ensureWebGpuDevice() {
  if (getWebGpuDevice()) return;
  if (!isWebGPUSupported() || typeof navigator === 'undefined' || !navigator.gpu) return;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return;
    setWebGpuDevice(await adapter.requestDevice());
    console.info('[ADPA] LiteRT had no WebGPU device; supplied one of ours');
  } catch (e) {
    // No device is the state we were already in, so this costs nothing but the log.
    console.warn('[ADPA] Could not create a WebGPU device for LiteRT', e);
  }
}

// LiteRT only loads the multithreaded WASM build when threads:true is passed; it
// does NOT infer this from crossOriginIsolated. So we opt in explicitly when the
// page is cross-origin isolated (SharedArrayBuffer available), which is what the
// threaded backend needs. If threaded init fails (e.g. no relaxed-SIMD support),
// LiteRT clears its global promise on rejection, so we can safely retry the
// single-threaded load. This benefits the CPU/WASM path; the WebGPU path is
// unaffected since it still loads the same core runtime.
async function loadLiteRtWithBestCpuBackend() {
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  if (isolated) {
    try {
      await loadLiteRt(LITERT_WASM_PATH, { threads: true });
      console.info("[ADPA] LiteRT: multithreaded WASM backend enabled");
      return;
    } catch (threadError) {
      console.warn("[ADPA] LiteRT: threaded WASM unavailable, falling back to single-threaded", threadError);
    }
  }
  await loadLiteRt(LITERT_WASM_PATH);
}

let currentRunner: ModelRunner | null = null;
let currentModelUrl: string | null = null;
let preprocessingCanvas: AnyCanvas | null = null;
let preprocessingCtx: AnyCanvas2D | null = null;
let preprocessingCanvasType: string | null = null;
let preprocessingInputSize = 0;
let preprocessingInputBuffer: Float32Array | null = null;

export async function loadModel(modelUrl: string, preferredAccelerator = "webgpu"): Promise<ModelRunner> {
  if (currentModelUrl !== modelUrl) {
    await unloadModel();
    currentModelUrl = modelUrl;
  }

  if (currentRunner) return currentRunner;

  await ensureLiteRtReady();

  if (preferredAccelerator === "wasm") {
    currentRunner = await loadWasmRunner(modelUrl);
    return currentRunner;
  }

  try {
    currentRunner = await loadWebGpuRunner(modelUrl);
    return currentRunner;
  } catch (webGpuError) {
    console.warn("[ADPA] LiteRT: webgpu failed, falling back to wasm", webGpuError);
    currentRunner = await loadWasmRunner(modelUrl);
    currentRunner.webGpuError = webGpuError;
    return currentRunner;
  }
}

export async function unloadModel() {
  if (currentRunner && typeof currentRunner.delete === "function") {
    currentRunner.delete();
  }
  currentRunner = null;
  currentModelUrl = null;
}

async function loadWebGpuRunner(modelUrl: string) {
  const model = await loadAndCompile(modelUrl, { accelerator: "webgpu" });
  return createWebGpuRunner(model);
}

function getWasmThreadCount() {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || WASM_MAX_THREADS;
  return Math.max(1, Math.min(cores, WASM_MAX_THREADS));
}

async function loadWasmRunner(modelUrl: string) {
  // Cap inference threads (WASM_MAX_THREADS); null disables the cap and lets
  // LiteRT default to navigator.hardwareConcurrency.
  const compileOptions: { accelerator: string; cpuOptions?: { numThreads: number } } = { accelerator: "wasm" };
  if (WASM_MAX_THREADS != null) {
    compileOptions.cpuOptions = { numThreads: getWasmThreadCount() };
  }
  const model = await loadAndCompile(modelUrl, compileOptions as Parameters<typeof loadAndCompile>[1]);
  return createWasmRunner(model);
}

function getSourceDimensions(source: FrameSource) {
  // Each kind of source names its own size differently, and none of them share a base type.
  const any = source as { videoWidth?: number; displayWidth?: number; width?: number; videoHeight?: number; displayHeight?: number; height?: number };
  const w = any.videoWidth || any.displayWidth || any.width || 0;
  const h = any.videoHeight || any.displayHeight || any.height || 0;
  if (!w || !h) throw new Error("Invalid source dimensions");
  return { width: w, height: h };
}

// Exported because lens calibration freezes the exact square the model was fed, and it has to crop
// the video the same way the inference path does or the projected spider would sit on a
// differently-framed picture.
export function getCenterSquareCrop(source: FrameSource) {
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

function ensurePreprocessingResources(inputSize: number) {
  if (!preprocessingCanvas) {
    if (typeof OffscreenCanvas === "function") {
      preprocessingCanvas = new OffscreenCanvas(inputSize, inputSize);
      preprocessingCanvasType = "OffscreenCanvas";
    } else {
      preprocessingCanvas = document.createElement("canvas");
      preprocessingCanvasType = "HTMLCanvasElement";
    }
    console.info("[ADPA] Preprocessing canvas", {
      type: preprocessingCanvasType,
    });
  }

  if (!preprocessingCtx) {
    preprocessingCtx = preprocessingCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    }) as AnyCanvas2D | null;
  }

  if (preprocessingInputSize !== inputSize) {
    preprocessingCanvas.width = inputSize;
    preprocessingCanvas.height = inputSize;
    preprocessingCtx!.imageSmoothingEnabled = true;
    preprocessingCtx!.imageSmoothingQuality = "high";
    preprocessingInputSize = inputSize;
    preprocessingInputBuffer = new Float32Array(inputSize * inputSize * 3);
  }

  // Everything above has just built whichever of these was missing.
  return {
    canvas: preprocessingCanvas,
    ctx: preprocessingCtx as AnyCanvas2D,
    inputBuffer: preprocessingInputBuffer as Float32Array,
  };
}

function createCpuInputTensor(sourceFrame: FrameSource, inputSize: number) {
  const inputBuffer = fillCpuInputBuffer(sourceFrame, inputSize);
  return new Tensor(inputBuffer, [1, 3, inputSize, inputSize]);
}

function fillCpuInputBuffer(sourceFrame: FrameSource, inputSize: number) {
  // Convert the captured frame to the model's square RGB float tensor.
  const { cropX, cropY, cropSize } = getCenterSquareCrop(sourceFrame);
  const { ctx, inputBuffer } = ensurePreprocessingResources(inputSize);
  ctx.drawImage(sourceFrame, cropX, cropY, cropSize, cropSize, 0, 0, inputSize, inputSize);
  const imageData = ctx.getImageData(0, 0, inputSize, inputSize);
  const rgbaPixels = imageData.data;

  const pixelCount = inputSize * inputSize;
  const greenOffset = pixelCount;
  const blueOffset = pixelCount * 2;
  for (let i = 0; i < pixelCount; i++) {
    const src = i * 4;
    inputBuffer[i] = rgbaPixels[src] / 255;
    inputBuffer[greenOffset + i] = rgbaPixels[src + 1] / 255;
    inputBuffer[blueOffset + i] = rgbaPixels[src + 2] / 255;
  }
  return inputBuffer;
}

function outputNeedsWasmCopy(tensor: Tensor): boolean {
  if (typeof tensor?.moveTo !== "function") return false;
  // Both of these are read loosely on purpose: which one LiteRT provides has changed between
  // versions, and the answer only decides whether a copy is needed before reading.
  const loose = tensor as unknown as { getBufferType?: () => unknown; accelerator?: unknown };
  if (typeof loose.getBufferType === "function") {
    return String(loose.getBufferType()) !== "wasm";
  }
  if (loose.accelerator) {
    return String(loose.accelerator) !== "wasm";
  }
  return true;
}

function createWebGpuPreprocessor() {
  const maybeDevice = getWebGpuDevice();
  if (!maybeDevice) {
    throw new Error("LiteRT WebGPU device is not available");
  }
  // Bound again so it is non-null for the closures below: a narrowing does not survive into them.
  const device: GPUDevice = maybeDevice;

  const shaderModule = device.createShaderModule({
    label: "ADPA image preprocessing shader",
    code: WEBGPU_PREPROCESS_SHADER,
  });
  const pipeline = device.createComputePipeline({
    label: "ADPA image preprocessing pipeline",
    layout: "auto",
    compute: {
      module: shaderModule,
      entryPoint: "main",
    },
  });
  const sampler = device.createSampler({
    label: "ADPA image preprocessing sampler",
    magFilter: "linear",
    minFilter: "linear",
  });

  let sourceTexture: GPUTexture | null = null;
  let sourceSize = 0;
  let outputBuffer: GPUBuffer | null = null;
  let outputInputSize = 0;
  let paramsBuffer: GPUBuffer | null = null;
  let bindGroup: GPUBindGroup | null = null;

  console.info("[ADPA] WebGPU preprocessing enabled");

  function ensureSourceTexture(cropSize: number): void {
    if (sourceTexture && sourceSize === cropSize) return;
    sourceTexture?.destroy?.();
    sourceTexture = device.createTexture({
      label: "ADPA preprocessing source texture",
      size: [cropSize, cropSize, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    sourceSize = cropSize;
    bindGroup = null;
  }

  function ensureOutputBuffer(inputSize: number): void {
    if (outputBuffer && outputInputSize === inputSize) return;
    outputBuffer?.destroy?.();
    outputBuffer = device.createBuffer({
      label: "ADPA preprocessing output tensor buffer",
      size: inputSize * inputSize * 3 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    outputInputSize = inputSize;
    bindGroup = null;
  }

  function ensureParamsBuffer() {
    if (paramsBuffer) return;
    paramsBuffer = device.createBuffer({
      label: "ADPA preprocessing params buffer",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    bindGroup = null;
  }

  function ensureBindGroup() {
    if (bindGroup) return bindGroup;
    bindGroup = device.createBindGroup({
      label: "ADPA preprocessing bind group",
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: sourceTexture!.createView(),
        },
        {
          binding: 1,
          resource: sampler,
        },
        {
          binding: 2,
          resource: { buffer: outputBuffer! },
        },
        {
          binding: 3,
          resource: { buffer: paramsBuffer! },
        },
      ],
    });
    return bindGroup;
  }

  function runComputePass(inputSize: number) {
    ensureOutputBuffer(inputSize);
    ensureParamsBuffer();

    const pixelCount = inputSize * inputSize;
    device.queue.writeBuffer(paramsBuffer!, 0, new Uint32Array([
      inputSize,
      pixelCount,
      0,
      0,
    ]));

    const encoder = device.createCommandEncoder({
      label: "ADPA preprocessing command encoder",
    });
    const pass = encoder.beginComputePass({
      label: "ADPA preprocessing compute pass",
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, ensureBindGroup());
    const workgroupCount = Math.ceil(inputSize / WEBGPU_PREPROCESS_WORKGROUP_SIZE);
    pass.dispatchWorkgroups(workgroupCount, workgroupCount);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return new Tensor(outputBuffer!, [1, 3, inputSize, inputSize], "float32");
  }

  return {
    // Upload via createImageBitmap (the broadest-compatibility WebGPU copy source), letting the
    // browser do a high-quality resize to inputSize when it honors the resize options. The source
    // texture is sized from the *returned* bitmap, so the compute shader still scales correctly if a
    // browser ignores those options and hands back a crop-sized bitmap.
    async preprocess(sourceFrame: FrameSource, inputSize: number): Promise<Tensor> {
      if (typeof createImageBitmap !== "function") {
        throw new Error("createImageBitmap is not available");
      }
      const { cropX, cropY, cropSize } = getCenterSquareCrop(sourceFrame);
      const bitmap = await createImageBitmap(sourceFrame, cropX, cropY, cropSize, cropSize, {
        resizeWidth: inputSize,
        resizeHeight: inputSize,
        resizeQuality: "high",
      });

      // createImageBitmap has resolved; the remaining GPU queue calls are synchronous, so these
      // error scopes stay balanced (popped in finally) even if a call throws. WebGPU reports copy /
      // dispatch failures asynchronously rather than throwing, so without this they would be
      // swallowed and the input would silently run on a garbage tensor.
      device.pushErrorScope("out-of-memory");
      device.pushErrorScope("validation");
      let tensor = null;
      let scopeError = null;
      try {
        ensureSourceTexture(bitmap.width);
        device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture: sourceTexture! },
          { width: bitmap.width, height: bitmap.height }
        );
        tensor = runComputePass(inputSize);
      } finally {
        bitmap.close?.();
        const validationError = await device.popErrorScope();
        const oomError = await device.popErrorScope();
        scopeError = validationError || oomError;
      }
      if (scopeError) {
        deleteTensor(tensor);
        throw new Error(`WebGPU preprocessing error: ${scopeError.message || scopeError}`);
      }
      return tensor;
    },
    delete() {
      sourceTexture?.destroy?.();
      outputBuffer?.destroy?.();
      paramsBuffer?.destroy?.();
      sourceTexture = null;
      outputBuffer = null;
      paramsBuffer = null;
      bindGroup = null;
      sourceSize = 0;
    },
  };
}

async function readOutputs(outputs: TensorList | null, needsWasmCopy: (tensor: Tensor) => boolean) {
  const result: ArrayLike<number>[] = [];
  if (outputs) {
    for (const out of outputs) {
      if (!out) continue;
      let cpu: Tensor = out;
      let moved: Tensor | null = null;
      if (needsWasmCopy(out)) {
        try {
          moved = await out.moveTo("wasm");
          cpu = moved;
        } catch {
          // Already on CPU
        }
      }
      if (typeof cpu.toTypedArray === "function") {
        result.push(cpu.toTypedArray());
      }
      if (moved && moved !== out && typeof moved.delete === "function") {
        moved.delete();
      }
      if (typeof out.delete === "function") {
        out.delete();
      }
    }
    // Delete the outputs container itself
    if (typeof outputs.delete === "function") {
      outputs.delete();
    }
  }
  return result;
}

function deleteTensor(tensor: Tensor | null | undefined): void {
  if (tensor && typeof tensor.delete === "function") {
    tensor.delete();
  }
}

function getModelDetails(model: any) {
  const isFullyAccelerated = typeof model?.isFullyAccelerated === "function"
    ? model.isFullyAccelerated()
    : model?.isFullyAccelerated;
  return {
    isFullyAccelerated,
    inputDetails: model?.getInputDetails?.(),
    outputDetails: model?.getOutputDetails?.(),
  };
}

/**
 * The CPU inference runner — which can still preprocess on the GPU, if asked and if there is one.
 *
 * That combination is not obviously silly and not obviously worthwhile, which is exactly why it is
 * available to be measured rather than assumed either way. The shader does the resize and the
 * planar-float conversion far faster than the JS loop, and then the whole input tensor has to come
 * back across to WASM memory to be run: **11.1 MB at 960 px, 19.7 MB at 1280**. Whether that trade
 * pays depends entirely on the device, and the self-test in `lib/onboarding.ts` is what asks it.
 *
 * The GPU path is opt-in per call and latches off on failure, exactly as the WebGPU runner's does.
 * With no options — every existing caller — this behaves precisely as it always has.
 */
function createWasmRunner(model: any): ModelRunner {
  let gpuPreprocessor: ReturnType<typeof createWebGpuPreprocessor> | null = null;
  let gpuPreprocessorDisabled = !ENABLE_WEBGPU_PREPROCESSING;

  /** Built on first use rather than at construction: most runs of this runner never want it. */
  function ensureGpuPreprocessor() {
    if (gpuPreprocessor || gpuPreprocessorDisabled) return gpuPreprocessor;
    try {
      gpuPreprocessor = createWebGpuPreprocessor();
    } catch (e) {
      gpuPreprocessorDisabled = true;
      console.warn("[ADPA] LiteRT: WebGPU preprocessing unavailable to the CPU runner", e);
    }
    return gpuPreprocessor;
  }

  return {
    accelerator: "wasm",
    ...getModelDetails(model),
    async run(sourceFrame, inputSize, options = {}) {
      let gpuTensor: Tensor | null = null;
      let inputTensor: Tensor | null = null;
      let preprocessMode = "cpu";

      if (!options.forceCpuPreprocessing && ensureGpuPreprocessor()) {
        try {
          gpuTensor = await gpuPreprocessor!.preprocess(sourceFrame, inputSize);
          // The readback. `moveTo` is what makes the GPU actually finish the work as well as hand
          // it over, so the cost of the shader is inside this await rather than hidden behind it.
          inputTensor = await gpuTensor.moveTo("wasm");
          preprocessMode = "gpu-bitmap";
        } catch (e) {
          gpuPreprocessorDisabled = true;
          console.warn("[ADPA] LiteRT: WebGPU preprocessing failed on the CPU runner; using CPU preprocessing", e);
        }
      }
      if (!inputTensor) inputTensor = createCpuInputTensor(sourceFrame, inputSize);

      let outputs = null;
      const tModel = performance.now();
      try {
        outputs = await model.run(inputTensor);
      } finally {
        // Both, when the GPU path ran: `moveTo` hands back a second tensor and leaves the first.
        deleteTensor(gpuTensor);
        deleteTensor(inputTensor);
      }
      const result = await readOutputs(outputs, () => false);
      return {
        outputs: result,
        modelMs: performance.now() - tModel,
        preprocessMode,
      };
    },
    delete() {
      // It may have built one lazily; the WebGPU runner releases its own the same way.
      gpuPreprocessor?.delete?.();
      deleteTensor(model);
    },
  };
}

function createWebGpuRunner(model: any): ModelRunner {
  let gpuPreprocessor: ReturnType<typeof createWebGpuPreprocessor> | null = null;
  let gpuPreprocessorDisabled = !ENABLE_WEBGPU_PREPROCESSING;
  if (ENABLE_WEBGPU_PREPROCESSING) {
    try {
      gpuPreprocessor = createWebGpuPreprocessor();
    } catch (e) {
      gpuPreprocessorDisabled = true;
      console.warn("[ADPA] LiteRT: WebGPU preprocessing unavailable; using CPU preprocessing", e);
    }
  }

  async function createMovedCpuInputTensor(sourceFrame: FrameSource, inputSize: number) {
    const inputTensor = createCpuInputTensor(sourceFrame, inputSize);
    let inferenceInput = inputTensor;
    let gpuInput = null;
    try {
      gpuInput = await inputTensor.moveTo("webgpu");
      inferenceInput = gpuInput;
    } catch {
      // Match the previous behavior: keep the CPU tensor if the transfer fails.
    }
    return {
      inferenceInput,
      preprocessMode: "cpu",
      cleanup() {
        deleteTensor(gpuInput);
        deleteTensor(inputTensor);
      },
    };
  }

  async function createGpuPreprocessedInputTensor(sourceFrame: FrameSource, inputSize: number) {
    const inputTensor = await gpuPreprocessor!.preprocess(sourceFrame, inputSize);
    return {
      inferenceInput: inputTensor,
      preprocessMode: "gpu-bitmap",
      cleanup() {
        deleteTensor(inputTensor);
      },
    };
  }

  return {
    accelerator: "webgpu",
    ...getModelDetails(model),
    async run(sourceFrame, inputSize, options = {}) {
      let input = null;
      if (ENABLE_WEBGPU_PREPROCESSING && !options.forceCpuPreprocessing && gpuPreprocessor && !gpuPreprocessorDisabled) {
        try {
          input = await createGpuPreprocessedInputTensor(sourceFrame, inputSize);
        } catch (e) {
          gpuPreprocessorDisabled = true;
          console.warn("[ADPA] LiteRT: WebGPU preprocessing failed; using CPU preprocessing", e);
        }
      }
      if (!input) {
        input = await createMovedCpuInputTensor(sourceFrame, inputSize);
      }

      let outputs = null;
      const tModel = performance.now();
      try {
        outputs = await model.run(input.inferenceInput);
      } finally {
        input.cleanup();
      }
      const result = await readOutputs(outputs, outputNeedsWasmCopy);
      return {
        outputs: result,
        modelMs: performance.now() - tModel,
        preprocessMode: input.preprocessMode,
      };
    },
    delete() {
      gpuPreprocessor?.delete?.();
      deleteTensor(model);
    },
  };
}
