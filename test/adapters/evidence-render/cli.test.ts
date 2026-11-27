import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../../src/adapters/evidence-render/cli.ts', import.meta.url));

function render(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'], HOME: process.env['HOME'] } });
}

async function pixel(file: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.subarray(i, i + 3)];
}

async function solid(file: string, width: number, height: number, background: string): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background } }).png().toFile(file);
}

const PLATE_ON_WHITE = Math.round(255 * (1 - 0xb3 / 255));

describe('antipod-evidence (AD-20, DESIGN tokens)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antipod-render-'));

  it('composite: a portrait 1080x2400 pair goes side by side with the 8 px white divider and BEFORE/AFTER plates', async () => {
    await solid(join(dir, 'before.png'), 1080, 2400, '#ffffff');
    await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#3366cc' } }).jpeg().toFile(join(dir, 'after.jpg'));
    const result = render('composite', '--before', join(dir, 'before.png'), '--after', join(dir, 'after.jpg'), '--out', join(dir, 'out.png'));
    expect(result.status, result.stderr).toBe(0);
    expect(await sharp(join(dir, 'out.png')).metadata()).toMatchObject({ format: 'png', width: 2168, height: 2400 });
    // Plate #000000B3 over white, inset 12 px, inside its 12 px padding.
    for (const channel of await pixel(join(dir, 'out.png'), 16, 16)) expect(Math.abs(channel - PLATE_ON_WHITE)).toBeLessThanOrEqual(2);
    expect(await pixel(join(dir, 'out.png'), 1083, 1200)).toEqual([255, 255, 255]);
    // JPEG input: the after half keeps its colour within JPEG rounding.
    const after = await pixel(join(dir, 'out.png'), 1500, 1200);
    [51, 102, 204].forEach((value, i) => expect(Math.abs(after[i]! - value)).toBeLessThanOrEqual(2));
    // The AFTER plate sits top-left of the after half.
    expect((await pixel(join(dir, 'out.png'), 1088 + 16, 16))[2]).toBeLessThan(80);
  });

  it('composite: landscape images stack, before on top', async () => {
    await solid(join(dir, 'wide.png'), 1920, 1080, '#ffffff');
    expect(render('composite', '--before', join(dir, 'wide.png'), '--after', join(dir, 'wide.png'), '--out', join(dir, 'stack.png')).status).toBe(0);
    expect(await sharp(join(dir, 'stack.png')).metadata()).toMatchObject({ width: 1920, height: 2168 });
  });

  it('label burns a plate top-left; callout draws the yellow stroke on a black halo', async () => {
    await solid(join(dir, 'shot.png'), 1080, 1920, '#ffffff');
    expect(render('label', '--in', join(dir, 'shot.png'), '--text', 'AC2 · default is 90 s', '--out', join(dir, 'label.png')).status).toBe(0);
    for (const channel of await pixel(join(dir, 'label.png'), 16, 16)) expect(Math.abs(channel - PLATE_ON_WHITE)).toBeLessThanOrEqual(2);
    expect(render('callout', '--in', join(dir, 'shot.png'), '--box', '100,200,300,150', '--out', join(dir, 'callout.png')).status).toBe(0);
    // Stroke centred on the edge: yellow on the line, black just outside it.
    expect(await pixel(join(dir, 'callout.png'), 100, 275)).toEqual([255, 212, 0]);
    expect(await pixel(join(dir, 'callout.png'), 97, 275)).toEqual([0, 0, 0]);
    expect(await pixel(join(dir, 'callout.png'), 250, 275)).toEqual([255, 255, 255]);
  });

  it('bad input exits non-zero with the reason', () => {
    writeFileSync(join(dir, 'not.png'), 'text');
    const missing = render('composite', '--before', join(dir, 'nope.png'), '--after', join(dir, 'before.png'), '--out', join(dir, 'x.png'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('nope.png cannot be read as an image');
    expect(render('composite', '--before', join(dir, 'not.png'), '--after', join(dir, 'before.png'), '--out', join(dir, 'x.png')).status).not.toBe(0);
    expect(render('callout', '--in', join(dir, 'shot.png'), '--box', '1,2,3', '--out', join(dir, 'x.png')).status).toBe(2);
    expect(render('callout', '--in', join(dir, 'shot.png'), '--box', '1000,1900,300,150', '--out', join(dir, 'x.png')).status).toBe(1);
    expect(render('label', '--in', join(dir, 'shot.png'), '--out', join(dir, 'x.png')).status).toBe(2);
    expect(render('draw').status).toBe(2);
  });
});
