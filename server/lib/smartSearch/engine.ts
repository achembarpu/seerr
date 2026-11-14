import { appDataPath } from '@server/utils/appDataVolume';
import axios from 'axios';
import { spawn, type ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, stat, unlink } from 'fs/promises';
import net from 'net';
import path from 'path';
import { pipeline } from 'stream/promises';

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
  // Do not pass local inference traffic through the configured outbound proxy.
  private readonly local = axios.create({ proxy: false });
  private readonly key = randomBytes(24).toString('hex');
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
    if (this.phase === 'ready' && this.process) return;
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
    const modelPath = await this.model(signal);
    signal.throwIfAborted();
    this.phase = 'starting';
    const port = await freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    const binary = process.env.SEERR_LLAMA_SERVER || 'llama-server';
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
        process.env.SEERR_LLAMA_GPU_LAYERS || '0',
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
          this.phase = 'ready';
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
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
    const response = await this.local.post<{
      data: { embedding: number[]; index: number }[];
    }>(
      `${this.baseUrl}/v1/embeddings`,
      { input: texts },
      {
        timeout: 120000,
        headers: { Authorization: `Bearer ${this.key}` },
        proxy: false,
      }
    );
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
    this.phase = 'idle';
  }
}
