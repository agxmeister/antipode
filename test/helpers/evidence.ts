/** A box: 32-bit size, 4-character type, payload. */
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/**
 * A minimal MP4 (`ftyp`, `moov/mvhd`, then `mdat`) lasting `seconds`: enough for ingest's `mvhd` read.
 * Version 1 writes 64-bit times; `moovLast` puts `moov` after `mdat`, as many encoders do.
 */
export function mp4Bytes(seconds: number, options: { version?: 0 | 1; moovLast?: boolean; timescale?: number } = {}): Buffer {
  const timescale = options.timescale ?? 1000;
  const duration = Math.round(seconds * timescale);
  let mvhd: Buffer;
  if (options.version === 1) {
    mvhd = Buffer.alloc(32 + 80);
    mvhd.writeUInt8(1, 0);
    mvhd.writeUInt32BE(timescale, 20);
    mvhd.writeBigUInt64BE(BigInt(duration), 24);
  } else {
    mvhd = Buffer.alloc(20 + 80);
    mvhd.writeUInt32BE(timescale, 12);
    mvhd.writeUInt32BE(duration, 16);
  }
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1'));
  const moov = box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', Buffer.alloc(16))]));
  const mdat = box('mdat', Buffer.alloc(64, 7));
  return Buffer.concat(options.moovLast === true ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

