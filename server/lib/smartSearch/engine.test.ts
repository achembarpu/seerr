import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import os from 'os';
import path from 'path';
import { EmbeddingEngine, parseDevices } from './engine';

it('checks model weights again when the file changes before a restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-weights-'));
  try {
    const filename = path.join(directory, 'weights.gguf');
    await writeFile(filename, 'valid');
    const { atime, mtime } = await stat(filename);
    const engine = new EmbeddingEngine() as unknown as {
      verifyWeights: (
        filename: string,
        expected: string,
        signal: AbortSignal
      ) => Promise<boolean | undefined>;
    };
    const expected = createHash('sha256').update('valid').digest('hex');
    const signal = new AbortController().signal;
    assert.equal(await engine.verifyWeights(filename, expected, signal), true);
    assert.equal(await engine.verifyWeights(filename, expected, signal), true);
    await writeFile(filename, 'other');
    await utimes(filename, atime, mtime);
    assert.equal(await engine.verifyWeights(filename, expected, signal), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('inference devices', () => {
  let directory: string;
  let previousBinary: string | undefined;
  const launches = () => readFile(path.join(directory, 'launches'), 'utf8');

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'smart-device-'));
    const binary = path.join(directory, 'llama-server');
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
if (args.includes('--list-devices')) {
  console.log('Available devices:\\n  Vulkan0: Example GPU (4096 MiB, 3500 MiB free)\\n  BLAS: Accelerate (0 MiB, 0 MiB free)');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(path.join(directory, 'launches'))}, args.join(' ') + '\\n');
const gpu = args[args.indexOf('--device') + 1] === 'Vulkan0';
if (gpu && !process.env.FAKE_GPU_FAIL_PROBE) process.exit(1);
http.createServer((req, res) => { if (gpu && req.url === '/v1/embeddings') { res.writeHead(500); res.end(); return; } res.writeHead(200); res.end(req.url === '/v1/embeddings' ? JSON.stringify({data: [{index: 0, embedding: Array(384).fill(0)}]}) : '{}'); }).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
`,
      { mode: 0o755 }
    );
    previousBinary = process.env.SEERR_LLAMA_SERVER;
    process.env.SEERR_LLAMA_SERVER = binary;
  });

  after(async () => {
    if (previousBinary === undefined) delete process.env.SEERR_LLAMA_SERVER;
    else process.env.SEERR_LLAMA_SERVER = previousBinary;
    await rm(directory, { recursive: true, force: true });
  });

  it('finds GPU backends but excludes CPU and software renderers', () => {
    assert.deepEqual(
      parseDevices(`Available devices:
  MTL0: Apple M3 (0 MiB, 0 MiB free)
  Vulkan0: AMD Radeon (8192 MiB, 8000 MiB free)
  Vulkan1: llvmpipe (32768 MiB, 32768 MiB free)
  CUDA0: NVIDIA GPU (8192 MiB, 8000 MiB free)
  BLAS: Accelerate (0 MiB, 0 MiB free)`),
      [
        { name: 'MTL0', description: 'Apple M3' },
        { name: 'Vulkan0', description: 'AMD Radeon' },
        { name: 'CUDA0', description: 'NVIDIA GPU' },
      ]
    );
  });

  it('falls back to CPU in automatic mode when a GPU fails to start', async () => {
    const engine = new EmbeddingEngine();
    mock.method(
      engine as unknown as { model: () => Promise<string> },
      'model',
      async () => 'model.gguf'
    );
    try {
      await engine.start(new AbortController().signal);
      assert.equal(engine.activeDevice, 'cpu');
      assert.match(engine.deviceWarning ?? '', /Vulkan0 failed/);
      assert.match(await launches(), /--device Vulkan0[\s\S]*--device none/);
    } finally {
      engine.stop();
      mock.restoreAll();
    }
  });

  it('falls back if GPU inference fails after the server starts', async () => {
    process.env.FAKE_GPU_FAIL_PROBE = '1';
    const engine = new EmbeddingEngine();
    mock.method(
      engine as unknown as { model: () => Promise<string> },
      'model',
      async () => 'model.gguf'
    );
    try {
      await engine.start(new AbortController().signal);
      assert.equal(engine.activeDevice, 'cpu');
      assert.match(engine.deviceWarning ?? '', /Vulkan0 failed/);
    } finally {
      engine.stop();
      delete process.env.FAKE_GPU_FAIL_PROBE;
      mock.restoreAll();
    }
  });

  it('does not silently fall back for an explicitly chosen GPU', async () => {
    const engine = new EmbeddingEngine(() => 'Vulkan0');
    mock.method(
      engine as unknown as { model: () => Promise<string> },
      'model',
      async () => 'model.gguf'
    );
    try {
      await assert.rejects(
        engine.start(new AbortController().signal),
        /Embedding process exited/
      );
      assert.equal(engine.phase, 'idle');
      assert.equal(engine.activeDevice, undefined);
    } finally {
      engine.stop();
      mock.restoreAll();
    }
  });

  it('reports a selected device that is no longer present', async () => {
    const engine = new EmbeddingEngine(() => 'CUDA3');
    mock.method(
      engine as unknown as { model: () => Promise<string> },
      'model',
      async () => 'model.gguf'
    );
    try {
      await assert.rejects(
        engine.start(new AbortController().signal),
        /CUDA3 is unavailable/
      );
    } finally {
      engine.stop();
      mock.restoreAll();
    }
  });
});

describe('host inference', () => {
  it('checks the model identity and authenticates embedding requests', async () => {
    const key = 'a'.repeat(32);
    let model = 'seerr-bekko-q8-0b021421';
    let offline = false;
    const server = createServer((request, response) => {
      if (offline) {
        response.writeHead(503).end();
      } else if (request.headers.authorization !== `Bearer ${key}`) {
        response.writeHead(401).end();
      } else if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: model }] }));
      } else {
        response.end(
          JSON.stringify({
            data: [{ index: 0, embedding: Array(384).fill(1) }],
          })
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const oldUrl = process.env.SEERR_EMBEDDING_URL;
    const oldKey = process.env.SEERR_EMBEDDING_API_KEY;
    process.env.SEERR_EMBEDDING_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.SEERR_EMBEDDING_API_KEY = key;
    const engine = new EmbeddingEngine(() => 'external');
    try {
      await engine.start(new AbortController().signal);
      assert.equal(engine.activeDevice, 'external');
      assert.equal((await engine.embed(['example']))[0].length, 384);
      offline = true;
      await assert.rejects(engine.embed(['example']));
      assert.equal(engine.phase, 'idle');
      offline = false;
      model = 'different-model';
      await assert.rejects(
        engine.start(new AbortController().signal),
        /expected Seerr embedding model/
      );
      process.env.SEERR_EMBEDDING_URL = 'https://example.com';
      await assert.rejects(
        engine.start(new AbortController().signal),
        /must point to localhost/
      );
    } finally {
      engine.stop();
      if (oldUrl === undefined) delete process.env.SEERR_EMBEDDING_URL;
      else process.env.SEERR_EMBEDDING_URL = oldUrl;
      if (oldKey === undefined) delete process.env.SEERR_EMBEDDING_API_KEY;
      else process.env.SEERR_EMBEDDING_API_KEY = oldKey;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

it('retries an oversized local embedding with the model context limit', async () => {
  const received: unknown[] = [];
  const contextError =
    'input (5 tokens) is larger than the max context size (4 tokens). skipping';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    received.push(payload);
    if (request.url === '/tokenize') {
      response.end(
        JSON.stringify({
          tokens: payload.content === 'long input' ? [1, 2, 3, 4, 5] : [1, 2],
        })
      );
    } else if (payload.input[0] === 'long input') {
      response
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: contextError } }));
    } else if (payload.input[0] === 'invalid input') {
      response
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'Unrelated bad request' } }));
    } else {
      response.end(
        JSON.stringify({
          data: [
            { index: 1, embedding: Array(384).fill(2) },
            { index: 0, embedding: Array(384).fill(1) },
          ],
        })
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const engine = new EmbeddingEngine();
  engine.phase = 'ready';
  Object.assign(engine, {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  try {
    const embeddings = await engine.embed(['long input', 'short input']);
    assert.deepEqual(
      embeddings.map((vector) => vector[0]),
      [1, 2]
    );
    assert.deepEqual(received[0], { input: ['long input', 'short input'] });
    assert.deepEqual(received[3], { input: [[1, 2, 3, 4], 'short input'] });
    assert.deepEqual(
      new Set(received.slice(1, 3)),
      new Set([
        { content: 'long input', add_special: true },
        { content: 'short input', add_special: true },
      ])
    );
    await assert.rejects(engine.embed(['invalid input']), /status code 400/);
    assert.equal(received.length, 5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
