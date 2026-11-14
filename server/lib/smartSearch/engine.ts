import { appDataPath } from '@server/utils/appDataVolume';
import axios from 'axios';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, stat, unlink } from 'fs/promises';
import net from 'net';
import path from 'path';
import { pipeline } from 'stream/promises';
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

async function checksum(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
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
  constructor(private readonly configuredDevice: () => string = () => 'auto') {}
  downloadBytes = 0;
  downloadTotal = 118639520;
  phase: 'idle' | 'downloading' | 'starting' | 'ready' = 'idle';

  private async model(signal: AbortSignal): Promise<string> {
    const directory = path.join(appDataPath(), 'models');
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, modelName);
    if (
      await stat(filename).then(
        () => true,
        () => false
      )
    ) {
      if ((await checksum(filename)) === modelHash) return filename;
      await unlink(filename);
    }
    this.phase = 'downloading';
    this.downloadBytes = 0;
    const temporary = `${filename}.partial`;
    try {
      const response = await axios.get<NodeJS.ReadableStream>(modelUrl, {
        responseType: 'stream',
        signal,
        timeout: 60000,
        maxRedirects: 5,
      });
      response.data.on('data', (chunk: Buffer) => {
        this.downloadBytes += chunk.length;
      });
      await pipeline(response.data, createWriteStream(temporary), { signal });
      if ((await checksum(temporary)) !== modelHash)
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
    const selection = this.configuredDevice() || 'auto';
    if (selection === 'external') {
      this.phase = 'starting';
      await this.connectExternal(signal);
      return;
    }
    const modelPath = await this.model(signal);
    signal.throwIfAborted();
    this.phase = 'starting';
    const binary = process.env.SEERR_LLAMA_SERVER || 'llama-server';
    this.deviceWarning = undefined;
    try {
      const { stdout } = await execFileAsync(binary, ['--list-devices'], {
        timeout: 15000,
        signal,
        maxBuffer: 1024 * 1024,
      });
      this.devices = parseDevices(stdout);
    } catch (error) {
      signal.throwIfAborted();
      if (selection !== 'auto' && selection !== 'cpu') throw error;
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
    const child = spawn(
      binary,
      [
        '--model',
        modelPath,
        '--embedding',
        '--pooling',
        'mean',
        '--ctx-size',
        '512',
        '--threads',
        '2',
        '--parallel',
        '1',
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
      for (let i = 0; i < 120; i++) {
        signal.throwIfAborted();
        if (failure) throw failure;
        try {
          await this.local.get(`${this.baseUrl}/health`, {
            timeout: 1000,
            headers: { Authorization: `Bearer ${this.key}` },
            proxy: false,
          });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        this.phase = 'ready';
        await this.embed(['test']);
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

  async embed(texts: string[]): Promise<number[][]> {
    if (this.phase !== 'ready') throw new Error('Embedding model is not ready');
    let response;
    try {
      response = await this.local.post<{
        data: { embedding: number[]; index: number }[];
      }>(
        `${this.baseUrl}/v1/embeddings`,
        { input: texts },
        {
          timeout: 120000,
          headers: { Authorization: `Bearer ${this.externalKey ?? this.key}` },
          proxy: false,
        }
      );
    } catch (error) {
      // A host service may have restarted with another model. Force its model
      // identity to be checked again before accepting another embedding.
      if (this.externalKey) {
        this.externalKey = undefined;
        this.activeDevice = undefined;
        this.phase = 'idle';
      }
      throw error;
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

  stop(): void {
    this.process?.kill();
    this.process = undefined;
    this.externalKey = undefined;
    this.activeDevice = undefined;
    this.phase = 'idle';
  }
}
