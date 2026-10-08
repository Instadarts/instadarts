import { describe, expect, it, vi } from 'vitest';
import { TensorBufferType, type Tensor } from '@litertjs/core';
import { outputNeedsWasmCopy, readOutputs } from '../../src/client/vision/model';

/**
 * Reading the model's outputs back from the GPU.
 *
 * LiteRT's `run` returns while the inference is still queued on the GPU, and each output's
 * `moveTo("wasm")` is a staging copy plus a `mapAsync` round trip of its own. Awaiting them one after
 * the other makes every frame wait for a second round trip to an idle GPU, and nothing fails when
 * that comes back — the frame is just slower. CI has no WebGPU, so these fakes stand in for LiteRT
 * 2.5.3's tensors: `getBufferType()` is its numeric enum, a successful `moveTo` deletes the tensor
 * it moved, and a GPU tensor refuses `toTypedArray()`.
 */

interface FakeTensor {
  readonly accelerator: 'wasm' | 'webgpu';
  deleted: boolean;
  getBufferType(): number;
  toTypedArray(): Float32Array;
  moveTo(destination: string): Promise<FakeTensor>;
  delete(): void;
}

/** A tensor already in WASM memory, as every output of the CPU runner is. */
function hostTensor(values: number[]): FakeTensor {
  const tensor: FakeTensor = {
    accelerator: 'wasm',
    deleted: false,
    getBufferType: () => TensorBufferType.HOST_MEMORY,
    toTypedArray: () => {
      if (tensor.deleted) throw new Error('Tensor is deleted and cannot be used.');
      return Float32Array.from(values);
    },
    moveTo: vi.fn(async () => {
      const copy = hostTensor(values);
      tensor.delete();
      return copy;
    }),
    delete: vi.fn(() => { tensor.deleted = true; }),
  };
  return tensor;
}

/**
 * A tensor in GPU memory whose readback the test finishes or fails, before or after it starts —
 * the GPU does not wait for anyone to ask.
 */
function gpuTensor(values: number[]) {
  let outcome: { error: Error | null } | null = null;
  let settle: (() => void) | null = null;
  const handle = { moved: null as FakeTensor | null };
  const tensor: FakeTensor = {
    accelerator: 'webgpu',
    deleted: false,
    getBufferType: () => TensorBufferType.WEB_GPU_BUFFER_PACKED,
    toTypedArray: () => {
      throw new Error('Cannot convert a Tensor with WebGPU memory to a TypedArray.');
    },
    moveTo: vi.fn(() => new Promise<FakeTensor>((resolve, reject) => {
      settle = () => {
        if (outcome?.error) return reject(outcome.error);
        handle.moved = hostTensor(values);
        tensor.delete();
        resolve(handle.moved);
      };
      if (outcome) settle();
    })),
    delete: vi.fn(() => { tensor.deleted = true; }),
  };
  return Object.assign(handle, {
    tensor,
    finish() {
      outcome = { error: null };
      settle?.();
    },
    fail(error: Error) {
      outcome = { error };
      settle?.();
    },
  });
}

/** The container LiteRT's `run` hands the outputs back in. */
function outputs(...tensors: FakeTensor[]) {
  return Object.assign(tensors as unknown as Tensor[], { delete: vi.fn() });
}

const asTensor = (fake: FakeTensor) => fake as unknown as Tensor;
const plain = (read: ArrayLike<number>[]) => read.map((values) => Array.from(values));

describe('reading the model outputs', () => {
  it("starts every output's readback before it waits for any, and keeps the model's order", async () => {
    const single = gpuTensor([1, 2]);
    const multi = gpuTensor([3]);
    const reading = readOutputs(outputs(single.tensor, multi.tensor), outputNeedsWasmCopy);

    // Both copies are already queued behind the inference: the second does not wait for the first.
    expect(single.tensor.moveTo).toHaveBeenCalledOnce();
    expect(multi.tensor.moveTo).toHaveBeenCalledOnce();

    multi.finish();
    single.finish();
    expect(plain(await reading)).toEqual([[1, 2], [3]]);
    for (const output of [single, multi]) {
      expect(output.tensor.deleted).toBe(true);
      expect(output.moved?.deleted).toBe(true);
    }
  });

  it('reads outputs already in WASM memory in place instead of copying them', async () => {
    const host = hostTensor([4, 5]);
    expect(outputNeedsWasmCopy(asTensor(host))).toBe(false);
    expect(outputNeedsWasmCopy(asTensor(gpuTensor([6]).tensor))).toBe(true);

    const read = await readOutputs(outputs(host), outputNeedsWasmCopy);
    expect(host.moveTo).not.toHaveBeenCalled();
    expect(plain(read)).toEqual([[4, 5]]);
    expect(host.deleted).toBe(true);
  });

  it("releases every tensor and reports the readback's own error when one fails", async () => {
    const single = gpuTensor([1]);
    const multi = gpuTensor([2]);
    const list = outputs(single.tensor, multi.tensor);
    single.fail(new Error('Device is lost'));
    multi.finish();

    await expect(readOutputs(list, outputNeedsWasmCopy)).rejects.toThrow('Device is lost');
    expect(single.tensor.deleted).toBe(true);
    expect(multi.tensor.deleted).toBe(true);
    expect(multi.moved?.deleted).toBe(true);
    expect(list.delete).toHaveBeenCalledOnce();
  });
});
