import { appDataPath } from '@server/utils/appDataVolume';
import axios from 'axios';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, stat, unlink } from 'fs/promises';
import net from 'net';
import path from 'path';
import { pipeline } from 'stream/promises';
import { setTimeout as delay } from 'timers/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type InferenceDevice = { name: string; description: string };

/** Parse only actual GPU backends, excluding CPU accelerators and software Vulkan. */
export function parseDevices(output: string): InferenceDevice[] {
  return output.split('\n').flatMap((line) => {
    const match = line.match(
      /^\s*((?:Metal|MTL|Vulkan|CUDA|ROCm|HIP|SYCL|OpenCL|CANN|MUSA|VirtGPU)\w*):\s*(.+?)\s*\(\d+ MiB, \d+ MiB free\)\s*$/i
    );
    if (
      !match ||
      /llvmpipe|lavapipe|swiftshader|software rasterizer/i.test(match[2])
    )
      return [];
    return [{ name: match[1], description: match[2] }];
  });
}

const externalModelAlias = 'seerr-bekko-q8-0b021421';
const modelName = 'bekko-embedding-v1-a8m-Q8_0.gguf';
const modelHash =
  '0b0214214287e90ffb98ffb47e1071e5b193fb420d1d99b2ec8aab0ebb507fc0';
const modelUrl = `https://huggingface.co/hotchpotch/bekko-embedding-v1-a8m-GGUF/resolve/4acacdea60b9393ae247a6ebf5b5707938c9755b/${modelName}`;
const rerankerName = 'Qwen3-Reranker-0.6B-Q4_K_M.gguf';
const rerankerHash =
  '5290f5b9a2636be40baf807feafcfb222e0c4670a083fb3447d87993566190a9';
const rerankerUrl = `https://huggingface.co/gorse-io/Qwen3-Reranker-0.6B-GGUF/resolve/7af0c7c371b5ad3daf771ce4f6d091a4d38c799a/${rerankerName}`;

async function checksum(
  filename: string,
  signal: AbortSignal
): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, {
    highWaterMark: 1024 * 1024,
    signal,
  }))
    hash.update(chunk);
  return hash.digest('hex');
}

async function weightIdentity(filename: string): Promise<string | undefined> {
  try {
    const file = await stat(filename, { bigint: true });
    if (!file.isFile()) throw new Error('Model weights must be a regular file');
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Unable to allocate inference port'));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Manages the bundled inference process; model weights are downloaded on opt-in. */
export class EmbeddingEngine {
  private process?: ChildProcess;
  private starting?: Promise<void>;
  private baseUrl = '';
  private externalKey?: string;
  private verifiedWeights?: string;
  get externalAvailable(): boolean {
    return (
      !!process.env.SEERR_EMBEDDING_URL && !!process.env.SEERR_EMBEDDING_API_KEY
    );
  }
  // Do not pass local inference traffic through the configured outbound proxy.
  private readonly local = axios.create({ proxy: false });
  private readonly key = randomBytes(24).toString('hex');
  devices: InferenceDevice[] = [];
  activeDevice?: string;
  deviceWarning?: string;
  constructor(
    private readonly configuredDevice: () => string = () => 'auto',
    private readonly mode: 'embedding' | 'reranking' = 'embedding'
  ) {}
  downloadBytes = 0;
  get downloadTotal(): number {
    return this.mode === 'embedding' ? 118639520 : 396476320;
  }
  phase: 'idle' | 'downloading' | 'starting' | 'ready' = 'idle';

  private async verifyWeights(
    filename: string,
    expected: string,
    signal: AbortSignal
  ): Promise<boolean | undefined> {
    signal.throwIfAborted();
    const identity = await weightIdentity(filename);
    if (!identity) return undefined;
    const verifiedIdentity = `${expected}:${identity}`;
    if (this.verifiedWeights === verifiedIdentity) return true;
    const verified = (await checksum(filename, signal)) === expected;
    if ((await weightIdentity(filename)) !== identity)
      throw new Error('Model weights changed during SHA-256 verification');
    if (verified) this.verifiedWeights = verifiedIdentity;
    return verified;
  }

  private async model(signal: AbortSignal): Promise<string> {
    const directory = path.join(appDataPath(), 'models');
    await mkdir(directory, { recursive: true });
    const name = this.mode === 'embedding' ? modelName : rerankerName;
    const hash = this.mode === 'embedding' ? modelHash : rerankerHash;
    const url = this.mode === 'embedding' ? modelUrl : rerankerUrl;
    const filename = path.join(directory, name);
    const verified = await this.verifyWeights(filename, hash, signal);
    if (verified) return filename;
    if (verified === false) await unlink(filename);
    this.phase = 'downloading';
    this.downloadBytes = 0;
    const temporary = `${filename}.partial`;
    try {
      const response = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: 'stream',
        signal,
        timeout: 60000,
        maxRedirects: 5,
      });
      response.data.on('data', (chunk: Buffer) => {
        this.downloadBytes += chunk.length;
      });
      await pipeline(response.data, createWriteStream(temporary), { signal });
      if ((await checksum(temporary, signal)) !== hash)
        throw new Error('Downloaded model failed SHA-256 verification');
      await rename(temporary, filename);
      return filename;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.phase === 'ready' && (this.process || this.externalKey)) return;
    if (this.starting) return this.starting;
    this.starting = this.launch(signal)
      .catch((error) => {
        this.phase = 'idle';
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private async launch(signal: AbortSignal): Promise<void> {
    const configured = this.configuredDevice() || 'auto';
    const selection =
      configured === 'external' && this.mode === 'reranking'
        ? 'auto'
        : configured;
    if (selection === 'external') {
      this.phase = 'starting';
      await this.connectExternal(signal);
      return;
    }
    const binary = process.env.SEERR_LLAMA_SERVER || 'llama-server';
    const deviceProbe = execFileAsync(binary, ['--list-devices'], {
      timeout: 15000,
      signal,
      maxBuffer: 1024 * 1024,
    }).then(
      ({ stdout }) => ({ devices: parseDevices(stdout) }),
      (error: unknown) => ({ error })
    );
    const [modelPath, probe] = await Promise.all([
      this.model(signal),
      deviceProbe,
    ]);
    signal.throwIfAborted();
    this.phase = 'starting';
    this.deviceWarning = undefined;
    if ('devices' in probe) {
      this.devices = probe.devices;
    } else {
      if (selection !== 'auto' && selection !== 'cpu') throw probe.error;
      this.devices = [];
      this.deviceWarning = 'Could not detect GPU devices; trying CPU inference';
    }
    const device =
      selection === 'cpu'
        ? undefined
        : selection === 'auto'
          ? this.devices[0]
          : this.devices.find((item) => item.name === selection);
    if (selection !== 'auto' && selection !== 'cpu' && !device)
      throw new Error(`Inference device ${selection} is unavailable`);
    try {
      await this.launchProcess(binary, modelPath, device?.name, signal);
    } catch (error) {
      if (selection !== 'auto' || !device || signal.aborted) throw error;
      this.deviceWarning = `GPU ${device.name} failed to start; using CPU: ${error instanceof Error ? error.message : String(error)}`;
      await this.launchProcess(binary, modelPath, undefined, signal);
    }
  }

  private async connectExternal(signal: AbortSignal): Promise<void> {
    const endpoint = process.env.SEERR_EMBEDDING_URL;
    const key = process.env.SEERR_EMBEDDING_API_KEY;
    if (!endpoint || !key || key.length < 32)
      throw new Error(
        'Host inference requires SEERR_EMBEDDING_URL and a key of at least 32 characters'
      );
    const url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', 'host.docker.internal'].includes(
        url.hostname
      ) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error(
        'Host inference URL must point to localhost or host.docker.internal'
      );
    const baseUrl = url.origin;
    const response = await this.local.get<{ data: { id: string }[] }>(
      `${baseUrl}/v1/models`,
      {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 10000,
        signal,
      }
    );
    if (!response.data.data?.some((model) => model.id === externalModelAlias))
      throw new Error(
        'Host inference does not advertise the expected Seerr embedding model'
      );
    this.baseUrl = baseUrl;
    this.externalKey = key;
    this.phase = 'ready';
    try {
      await this.embed(['test']);
      signal.throwIfAborted();
      this.activeDevice = 'external';
    } catch (error) {
      this.externalKey = undefined;
      throw error;
    }
  }

  private async launchProcess(
    binary: string,
    modelPath: string,
    device: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const port = await freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    const metal = device?.startsWith('MTL');
    const metalEmbedding = this.mode === 'embedding' && metal;
    const metalBatch =
      this.mode === 'reranking' &&
      metal &&
      process.env.SEERR_NATIVE_METAL_RERANK === '1';
    const child = spawn(
      binary,
      [
        '--model',
        modelPath,
        ...(this.mode === 'embedding'
          ? ['--embedding', '--pooling', 'mean']
          : ['--reranking', '--pooling', 'rank']),
        '--ctx-size',
        this.mode === 'embedding'
          ? metalEmbedding
            ? '2048'
            : '512'
          : metalBatch
            ? '8192'
            : '2048',
        '--threads',
        '2',
        '--parallel',
        metalEmbedding || metalBatch ? '4' : '1',
        ...(metalEmbedding
          ? ['--batch-size', '1024', '--ubatch-size', '1024']
          : []),
        ...(metalBatch
          ? [
              '--batch-size',
              '1024',
              '--ubatch-size',
              '1024',
              '--kv-unified',
              '--kv-unified-per-slot',
              '2048',
              '--cache-ram',
              '0',
            ]
          : []),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--api-key',
        this.key,
        '--n-gpu-layers',
        device ? 'all' : '0',
        '--device',
        device ?? 'none',
        '--no-warmup',
      ],
      { stdio: 'ignore' }
    );
    this.process = child;
    const stopChild = () => child.kill();
    process.once('exit', stopChild);
    let failure: Error | undefined;
    child.once('error', (error) => {
      process.removeListener('exit', stopChild);
      failure = error;
    });
    child.once('exit', (code) => {
      process.removeListener('exit', stopChild);
      if (this.process === child) {
        this.process = undefined;
        this.activeDevice = undefined;
        this.phase = 'idle';
      }
      failure = new Error(`Embedding process exited (${code})`);
    });
    try {
      const started = performance.now();
      while (performance.now() - started < 30_000) {
        signal.throwIfAborted();
        if (failure) throw failure;
        try {
          await this.local.get(`${this.baseUrl}/health`, {
            timeout: 1000,
            signal,
            headers: { Authorization: `Bearer ${this.key}` },
            proxy: false,
          });
        } catch {
          await delay(
            performance.now() - started < 1000 ? 50 : 250,
            undefined,
            {
              signal,
            }
          );
          continue;
        }
        this.phase = 'ready';
        if (this.mode === 'embedding') await this.embed(['test']);
        else await this.rerank('test', ['test']);
        signal.throwIfAborted();
        this.activeDevice = device ?? 'cpu';
        return;
      }
      throw new Error('Embedding process did not start');
    } catch (error) {
      child.kill();
      this.process = undefined;
      this.phase = 'idle';
      throw error;
    }
  }

  async embed(
    texts: string[],
    signal?: AbortSignal,
    timeout = 120000
  ): Promise<number[][]> {
    if (this.phase !== 'ready') throw new Error('Embedding model is not ready');
    const options = {
      timeout,
      signal,
      headers: { Authorization: `Bearer ${this.externalKey ?? this.key}` },
      proxy: false as const,
    };
    const request = (input: (string | number[])[]) =>
      this.local.post<{ data: { embedding: number[]; index: number }[] }>(
        `${this.baseUrl}/v1/embeddings`,
        { input },
        options
      );
    let response;
    try {
      response = await request(texts);
    } catch (error) {
      // A host service may have restarted with another model. Force its model
      // identity to be checked again before accepting another embedding.
      if (this.externalKey) {
        if (!signal?.aborted) {
          this.externalKey = undefined;
          this.activeDevice = undefined;
          this.phase = 'idle';
        }
        throw error;
      }
      if (signal?.aborted) throw error;
      const message =
        axios.isAxiosError<{ error?: { message?: unknown } }>(error) &&
        error.response?.status === 400
          ? error.response.data?.error?.message
          : undefined;
      const context =
        typeof message === 'string'
          ? /^input \(\d+ tokens\) is larger than the max context size \((\d+) tokens\)\. skipping$/.exec(
              message
            )
          : null;
      if (!context) throw error;
      const limit = Number(context[1]);
      if (!Number.isSafeInteger(limit) || limit <= 0) throw error;
      // Use the model's tokenizer so multilingual text fits the actual slot.
      // Keep the normal string path for the other inputs in this batch.
      const input = await Promise.all(
        texts.map(async (text) => {
          const { data } = await this.local.post<{ tokens: number[] }>(
            `${this.baseUrl}/tokenize`,
            { content: text, add_special: true },
            options
          );
          return data.tokens.length > limit
            ? data.tokens.slice(0, limit)
            : text;
        })
      );
      if (!input.some(Array.isArray)) throw error;
      response = await request(input);
    }
    const data = response.data.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    if (
      data.length !== texts.length ||
      data.some(
        (vector) =>
          vector.length !== 384 ||
          vector.some((value) => !Number.isFinite(value))
      )
    )
      throw new Error('Invalid embedding response');
    return data;
  }

  async rerank(
    query: string,
    documents: string[],
    timeout = 6000,
    signal?: AbortSignal
  ): Promise<number[]> {
    if (this.phase !== 'ready') throw new Error('Reranker is not ready');
    if (!documents.length) return [];
    const response = await this.local.post<{
      results: { index: number; relevance_score: number }[];
    }>(
      `${this.baseUrl}/v1/rerank`,
      { model: rerankerName, query, documents },
      {
        timeout,
        signal,
        headers: { Authorization: `Bearer ${this.key}` },
        proxy: false,
      }
    );
    const scores = Array<number>(documents.length).fill(NaN);
    for (const item of response.data.results ?? []) {
      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= scores.length ||
        Number.isFinite(scores[item.index])
      )
        throw new Error('Invalid reranker response');
      scores[item.index] = item.relevance_score;
    }
    if (scores.some((score) => !Number.isFinite(score)))
      throw new Error('Invalid reranker response');
    return scores;
  }

  stop(): void {
    this.process?.kill();
    this.process = undefined;
    this.externalKey = undefined;
    this.activeDevice = undefined;
    this.phase = 'idle';
  }
}
