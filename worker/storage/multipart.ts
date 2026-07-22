const PART_BYTES = 5 * 1024 * 1024;

export async function multipartPut(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  options?: R2MultipartOptions,
): Promise<R2Object> {
  const upload = await bucket.createMultipartUpload(key, options);
  const completed: R2UploadedPart[] = [];
  const reader = stream.getReader();
  let buffer = new Uint8Array(PART_BYTES);
  let offset = 0;
  let partNumber = 1;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let sourceOffset = 0;
      while (sourceOffset < chunk.value.byteLength) {
        const length = Math.min(PART_BYTES - offset, chunk.value.byteLength - sourceOffset);
        buffer.set(chunk.value.subarray(sourceOffset, sourceOffset + length), offset);
        sourceOffset += length;
        offset += length;
        if (offset === PART_BYTES) {
          completed.push(await upload.uploadPart(partNumber, buffer));
          partNumber += 1;
          buffer = new Uint8Array(PART_BYTES);
          offset = 0;
        }
      }
    }
    if (offset > 0) completed.push(await upload.uploadPart(partNumber, buffer.subarray(0, offset)));
    return await upload.complete(completed);
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
}
