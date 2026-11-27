import { open, type FileHandle } from 'node:fs/promises';

/** Reads `length` bytes at `position`; fewer at the end of the file. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

interface Box {
  type: string;
  /** Offset of the box payload. */
  start: number;
  /** Offset just past the box. */
  end: number;
}

/** The boxes between `from` and `to`, in file order; stops at the first malformed header. */
async function boxes(handle: FileHandle, from: number, to: number): Promise<Box[]> {
  const found: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    const header = await readAt(handle, offset, 16);
    if (header.length < 8) break;
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let start = offset + 8;
    if (size === 1) {
      if (header.length < 16) break;
      size = Number(header.readBigUInt64BE(8));
      start = offset + 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < start - offset || offset + size > to) break;
    found.push({ type, start, end: offset + size });
    offset += size;
  }
  return found;
}

/**
 * The duration in seconds of an MP4 or QuickTime file, read from `moov/mvhd` (ISO/IEC 14496-12
 * §8.2.2): version 0 has 32-bit times, version 1 64-bit. Null when the file has no readable box.
 */
export async function mp4DurationSeconds(file: string): Promise<number | null> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const moov = (await boxes(handle, 0, size)).find((box) => box.type === 'moov');
    if (moov === undefined) return null;
    const mvhd = (await boxes(handle, moov.start, moov.end)).find((box) => box.type === 'mvhd');
    if (mvhd === undefined) return null;
    const body = await readAt(handle, mvhd.start, Math.min(32, mvhd.end - mvhd.start));
    if (body.length < 1) return null;
    const version = body.readUInt8(0);
    let timescale: number;
    let duration: number;
    if (version === 1) {
      if (body.length < 32) return null;
      timescale = body.readUInt32BE(20);
      duration = Number(body.readBigUInt64BE(24));
    } else {
      if (body.length < 20) return null;
      timescale = body.readUInt32BE(12);
      duration = body.readUInt32BE(16);
    }
    return timescale === 0 ? null : duration / timescale;
  } finally {
    await handle.close();
  }
}
