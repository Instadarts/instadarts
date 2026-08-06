// Ported verbatim from dartszentrale-ai-scorer src/vision/model.js.
// LiteRT runner: WebGPU first (with a WebGPU preprocessing shader), WASM CPU fallback.
// Heavily tuned for phone performance; do not "clean up" without a benchmark on a real device.
/**
 * TFLite model runner using @litertjs/core (npm).
 * Loads WebGPU first and falls back to WASM when WebGPU is unavailable.
 */
import { getWebGpuDevice, loadLiteRt, loadAndCompile, Tensor } from '@litertjs/core';

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
let liteRtPromise = null;

export async function ensureLiteRtReady() {
  if (liteRtReady) return;
  if (!liteRtPromise) {
    liteRtPromise = loadLiteRtWithBestCpuBackend().then(() => {
      liteRtReady = true;
    });
  }
  return liteRtPromise;
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

let currentRunner = null;
let currentModelUrl = null;
let preprocessingCanvas = null;
let preprocessingCtx = null;
let preprocessingCanvasType = null;
let preprocessingInputSize = 0;
let preprocessingInputBuffer = null;

export async function loadModel(modelUrl, preferredAccelerator = "webgpu") {
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

async function loadWebGpuRunner(modelUrl) {
  const model = await loadAndCompile(modelUrl, { accelerator: "webgpu" });
  return createWebGpuRunner(model);
}

function getWasmThreadCount() {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || WASM_MAX_THREADS;
  return Math.max(1, Math.min(cores, WASM_MAX_THREADS));
}

async function loadWasmRunner(modelUrl) {
  // Cap inference threads (WASM_MAX_THREADS); null disables the cap and lets
  // LiteRT default to navigator.hardwareConcurrency.
  const compileOptions = { accelerator: "wasm" };
  if (WASM_MAX_THREADS != null) {
    compileOptions.cpuOptions = { numThreads: getWasmThreadCount() };
  }
  const model = await loadAndCompile(modelUrl, compileOptions);
  return createWasmRunner(model);
}

function getSourceDimensions(source) {
  const w = source.videoWidth || source.displayWidth || source.width || 0;
  const h = source.videoHeight || source.displayHeight || source.height || 0;
  if (!w || !h) throw new Error("Invalid source dimensions");
  return { width: w, height: h };
}

// Exported here, unlike in the origin file: lens calibration freezes the exact square the model
// was fed, and it has to crop the video the same way the inference path does or the projected
// spider would sit on a differently-framed picture.
export function getCenterSquareCrop(source) {
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

function ensurePreprocessingResources(inputSize) {
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
    });
  }

  if (preprocessingInputSize !== inputSize) {
    preprocessingCanvas.width = inputSize;
    preprocessingCanvas.height = inputSize;
    preprocessingCtx.imageSmoothingEnabled = true;
    preprocessingCtx.imageSmoothingQuality = "high";
    preprocessingInputSize = inputSize;
    preprocessingInputBuffer = new Float32Array(inputSize * inputSize * 3);
  }

  return {
    canvas: preprocessingCanvas,
    ctx: preprocessingCtx,
    inputBuffer: preprocessingInputBuffer,
  };
}

export function drawLastInputFrame(targetCtx, inputSize) {
  if (!preprocessingCanvas || preprocessingInputSize !== inputSize) return false;
  targetCtx.drawImage(preprocessingCanvas, 0, 0, inputSize, inputSize);
  return true;
}

// Synchronously snapshot square close-up crops around normalized input-space
// centers, sampling directly from the source frame. This is independent of the
// CPU/GPU preprocessing path (the WebGPU path never populates the preprocessing
// canvas), and capturing now avoids losing the frame to the next inference. Each
// crop is a `normExtent` x `normExtent` window of the model's center-square crop,
// scaled to `outputSize`. Returns [{ id, canvas, w, h }]; the caller encodes.
export function cropInputRegions(sourceFrame, regions, normExtent, outputSize) {
  if (!Array.isArray(regions) || regions.length === 0) return [];
  const { cropX, cropY, cropSize } = getCenterSquareCrop(sourceFrame);
  const half = normExtent / 2;
  const results = [];
  for (const region of regions) {
    // Clamp the window center so the crop stays inside the input square.
    const cx = Math.min(Math.max(region.x, half), 1 - half);
    const cy = Math.min(Math.max(region.y, half), 1 - half);
    const sx = cropX + ((cx - half) * cropSize);
    const sy = cropY + ((cy - half) * cropSize);
    const sSize = normExtent * cropSize;
    const canvas = createCropCanvas(outputSize);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sourceFrame, sx, sy, sSize, sSize, 0, 0, outputSize, outputSize);
    results.push({ id: region.id, canvas, w: normExtent, h: normExtent });
  }
  return results;
}

function createCropCanvas(size) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(size, size);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createCpuInputTensor(sourceFrame, inputSize) {
  const inputBuffer = fillCpuInputBuffer(sourceFrame, inputSize);
  return new Tensor(inputBuffer, [1, 3, inputSize, inputSize]);
}

function fillCpuInputBuffer(sourceFrame, inputSize) {
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

function outputNeedsWasmCopy(tensor) {
  if (typeof tensor?.moveTo !== "function") return false;
  if (typeof tensor.getBufferType === "function") {
    return tensor.getBufferType() !== "wasm";
  }
  if (tensor.accelerator) {
    return tensor.accelerator !== "wasm";
  }
  return true;
}

function createWebGpuPreprocessor() {
  const device = getWebGpuDevice();
  if (!device) {
    throw new Error("LiteRT WebGPU device is not available");
  }

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

  let sourceTexture = null;
  let sourceSize = 0;
  let outputBuffer = null;
  let outputInputSize = 0;
  let paramsBuffer = null;
  let bindGroup = null;

  console.info("[ADPA] WebGPU preprocessing enabled");

  function ensureSourceTexture(cropSize) {
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

  function ensureOutputBuffer(inputSize) {
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
          resource: sourceTexture.createView(),
        },
        {
          binding: 1,
          resource: sampler,
        },
        {
          binding: 2,
          resource: { buffer: outputBuffer },
        },
        {
          binding: 3,
          resource: { buffer: paramsBuffer },
        },
      ],
    });
    return bindGroup;
  }

  function runComputePass(inputSize) {
    ensureOutputBuffer(inputSize);
    ensureParamsBuffer();

    const pixelCount = inputSize * inputSize;
    device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([
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

    return new Tensor(outputBuffer, [1, 3, inputSize, inputSize], "float32");
  }

  return {
    // Upload via createImageBitmap (the broadest-compatibility WebGPU copy source), letting the
    // browser do a high-quality resize to inputSize when it honors the resize options. The source
    // texture is sized from the *returned* bitmap, so the compute shader still scales correctly if a
    // browser ignores those options and hands back a crop-sized bitmap.
    async preprocess(sourceFrame, inputSize) {
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
          { texture: sourceTexture },
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

async function readOutputs(outputs, needsWasmCopy) {
  const result = [];
  if (outputs) {
    for (const out of outputs) {
      if (!out) continue;
      let cpu = out;
      let moved = null;
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

function deleteTensor(tensor) {
  if (tensor && typeof tensor.delete === "function") {
    tensor.delete();
  }
}

function getModelDetails(model) {
  const isFullyAccelerated = typeof model?.isFullyAccelerated === "function"
    ? model.isFullyAccelerated()
    : model?.isFullyAccelerated;
  return {
    isFullyAccelerated,
    inputDetails: model?.getInputDetails?.(),
    outputDetails: model?.getOutputDetails?.(),
  };
}

function createWasmRunner(model) {
  return {
    accelerator: "wasm",
    ...getModelDetails(model),
    async run(sourceFrame, inputSize) {
      const inputTensor = createCpuInputTensor(sourceFrame, inputSize);
      let outputs = null;
      const tModel = performance.now();
      try {
        outputs = await model.run(inputTensor);
      } finally {
        deleteTensor(inputTensor);
      }
      const result = await readOutputs(outputs, () => false);
      return {
        outputs: result,
        modelMs: performance.now() - tModel,
        preprocessMode: "cpu",
      };
    },
    delete() {
      deleteTensor(model);
    },
  };
}

function createWebGpuRunner(model) {
  let gpuPreprocessor = null;
  let gpuPreprocessorDisabled = !ENABLE_WEBGPU_PREPROCESSING;
  if (ENABLE_WEBGPU_PREPROCESSING) {
    try {
      gpuPreprocessor = createWebGpuPreprocessor();
    } catch (e) {
      gpuPreprocessorDisabled = true;
      console.warn("[ADPA] LiteRT: WebGPU preprocessing unavailable; using CPU preprocessing", e);
    }
  }

  async function createMovedCpuInputTensor(sourceFrame, inputSize) {
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

  async function createGpuPreprocessedInputTensor(sourceFrame, inputSize) {
    const inputTensor = await gpuPreprocessor.preprocess(sourceFrame, inputSize);
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
