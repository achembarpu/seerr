/** Normalize and quantize a vector without learning per-catalog parameters. */
export const quantize = (vector: readonly number[]): Buffer => {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm)) throw new Error('Invalid embedding');
  const result = Buffer.allocUnsafe(vector.length);
  vector.forEach((value, index) => {
    result.writeInt8(
      Math.max(-127, Math.min(127, Math.round((value * 127) / norm))),
      index
    );
  });
  return result;
};

export const cosine = (left: Uint8Array, right: Uint8Array): number => {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < left.length; i++) {
    const x = left[i] > 127 ? left[i] - 256 : left[i];
    const y = right[i] > 127 ? right[i] - 256 : right[i];
    dot += x * y;
    a += x * x;
    b += y * y;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
};

/** Prepare the fixed query once while scoring many signed quantized vectors. */
export const prepareCosine = (left: Uint8Array) => {
  const query = new Int8Array(left.buffer, left.byteOffset, left.byteLength);
  let queryNorm = 0;
  for (let i = 0; i < query.length; i++) queryNorm += query[i] * query[i];
  return (right: Uint8Array): number => {
    if (query.length !== right.length || !query.length || !queryNorm) return 0;
    const candidate = new Int8Array(
      right.buffer,
      right.byteOffset,
      right.byteLength
    );
    let dot = 0;
    let candidateNorm = 0;
    for (let i = 0; i < query.length; i++) {
      const value = candidate[i];
      dot += query[i] * value;
      candidateNorm += value * value;
    }
    return candidateNorm ? dot / Math.sqrt(queryNorm * candidateNorm) : 0;
  };
};
