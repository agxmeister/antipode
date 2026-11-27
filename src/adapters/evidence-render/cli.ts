#!/usr/bin/env node
/**
 * `antipod-evidence`: the one renderer of generated imagery (AD-20). The Evidence Producer runs it to
 * make before/after composites, labels and callout boxes with the DESIGN.md tokens and the bundled Inter.
 *
 *   antipod-evidence composite --before <png|jpg> --after <png|jpg> --out <png>
 *   antipod-evidence label --in <png|jpg> --text <text> --out <png>
 *   antipod-evidence callout --in <png|jpg> --box x,y,w,h --out <png>
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseColor, scaled, TOKENS } from './tokens.ts';

/** `src/adapters/evidence-render/` of the package, from `src/` or `dist/` alike: the fonts are not compiled. */
const ASSETS = fileURLToPath(new URL('../../../src/adapters/evidence-render/', import.meta.url));
// Read when sharp first lays out text: the bundled Inter is the only font fontconfig knows, and Pango
// asks fontconfig rather than the OS font service (CoreText on macOS), so labels never use a host font.
process.env['FONTCONFIG_FILE'] = join(ASSETS, 'fonts.conf');
process.env['PANGOCAIRO_BACKEND'] = 'fc';
const FONT_FILE = join(ASSETS, 'fonts', 'Inter-SemiBold.ttf');
const { default: sharp } = await import('sharp');

const USAGE = `Usage: antipod-evidence <command>

  composite --before <png|jpg> --after <png|jpg> --out <png>
      Before and after at equal scale: portrait side by side, landscape stacked, before first.
  label --in <png|jpg> --text <text> --out <png>
      Burns a label plate into the top-left corner.
  callout --in <png|jpg> --box x,y,w,h --out <png>
      Draws a callout box around the region.`;

class UsageError extends Error {}

interface Plate {
  buffer: Buffer;
  width: number;
  height: number;
}

function escapeMarkup(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** An input image's pixels and size; only PNG and JPEG are accepted. */
async function load(path: string): Promise<{ buffer: Buffer; width: number; height: number }> {
  let metadata;
  try {
    metadata = await sharp(path).metadata();
  } catch (error) {
    throw new Error(`${path} cannot be read as an image: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.format !== 'png' && metadata.format !== 'jpeg') throw new Error(`${path} is ${metadata.format ?? 'not an image'}; give a PNG or JPEG`);
  const buffer = await sharp(path).rotate().png().toBuffer();
  const { width, height } = await sharp(buffer).metadata();
  return { buffer, width: width ?? 0, height: height ?? 0 };
}

/**
 * A label plate for an image `imageWidth` wide (DESIGN `before-after-composite`): Inter 600 in the ink
 * colour on the translucent plate with rounded corners, all sized from the tokens.
 */
async function plate(text: string, imageWidth: number): Promise<Plate> {
  const size = scaled(TOKENS.fontSize, imageWidth);
  const pad = scaled(TOKENS.pad, imageWidth);
  const radius = scaled(TOKENS.radius, imageWidth);
  const ink = parseColor(TOKENS.ink);
  const rendered = await sharp({
    text: {
      text: `<span foreground="${ink.rgb}">${escapeMarkup(text)}</span>`,
      font: `${TOKENS.fontFamily} SemiBold ${size}`,
      fontfile: FONT_FILE,
      dpi: 72,
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  const width = rendered.info.width + 2 * pad;
  const height = Math.max(rendered.info.height, Math.round(size * TOKENS.lineHeight)) + 2 * pad;
  const fill = parseColor(TOKENS.plate);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill.rgb}" fill-opacity="${fill.opacity.toFixed(4)}"/></svg>`;
  const top = Math.round((height - rendered.info.height) / 2);
  const buffer = await sharp(Buffer.from(svg))
    .composite([{ input: rendered.data, left: pad, top }])
    .png()
    .toBuffer();
  return { buffer, width, height };
}

/** The plate of `text` placed top-left of a region `regionWidth` wide at `(left, top)`, shrunk to fit it. */
async function labelAt(text: string, regionWidth: number, regionHeight: number, left: number, top: number): Promise<{ input: Buffer; left: number; top: number }> {
  const inset = scaled(TOKENS.pad, regionWidth);
  let label = await plate(text, regionWidth);
  const room = Math.max(1, regionWidth - 2 * inset);
  const roomY = Math.max(1, regionHeight - 2 * inset);
  if (label.width > room || label.height > roomY) {
    const factor = Math.min(room / label.width, roomY / label.height);
    const width = Math.max(1, Math.floor(label.width * factor));
    const height = Math.max(1, Math.floor(label.height * factor));
    label = { buffer: await sharp(label.buffer).resize(width, height, { fit: 'fill' }).png().toBuffer(), width, height };
  }
  return { input: label.buffer, left: left + inset, top: top + inset };
}

/**
 * Before and after at equal scale with a divider gap (DESIGN Layout & Spacing): portrait images side by
 * side, landscape images stacked with before on top, each half labelled BEFORE or AFTER.
 */
async function composite(beforePath: string, afterPath: string, out: string): Promise<void> {
  const [before, after] = await Promise.all([load(beforePath), load(afterPath)]);
  const portrait = after.height > after.width;
  const gap = scaled(TOKENS.gap, portrait ? after.width : after.height);
  let first: { buffer: Buffer; width: number; height: number };
  if (portrait) {
    const width = Math.max(1, Math.round((before.width * after.height) / before.height));
    first = { buffer: await sharp(before.buffer).resize(width, after.height, { fit: 'fill' }).png().toBuffer(), width, height: after.height };
  } else {
    const height = Math.max(1, Math.round((before.height * after.width) / before.width));
    first = { buffer: await sharp(before.buffer).resize(after.width, height, { fit: 'fill' }).png().toBuffer(), width: after.width, height };
  }
  const width = portrait ? first.width + gap + after.width : after.width;
  const height = portrait ? after.height : first.height + gap + after.height;
  const afterLeft = portrait ? first.width + gap : 0;
  const afterTop = portrait ? 0 : first.height + gap;
  const divider = parseColor(TOKENS.divider);
  await sharp({ create: { width, height, channels: 4, background: divider.rgb } })
    .composite([
      { input: first.buffer, left: 0, top: 0 },
      { input: after.buffer, left: afterLeft, top: afterTop },
      await labelAt('BEFORE', first.width, first.height, 0, 0),
      await labelAt('AFTER', after.width, after.height, afterLeft, afterTop),
    ])
    .png()
    .toFile(out);
}

/** A label plate burned into the top-left corner of the image. */
async function label(input: string, text: string, out: string): Promise<void> {
  if (text.trim() === '') throw new UsageError('--text must not be empty');
  const image = await load(input);
  await sharp(image.buffer)
    .composite([await labelAt(text, image.width, image.height, 0, 0)])
    .png()
    .toFile(out);
}

/** `x,y,w,h` as integers; w and h positive. */
function parseBox(value: string): { x: number; y: number; w: number; h: number } {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) throw new UsageError(`--box must be x,y,w,h in whole pixels, got ${value}`);
  const [x, y, w, h] = parts.map(Number) as [number, number, number, number];
  if (w === 0 || h === 0) throw new UsageError('--box needs a positive width and height');
  return { x, y, w, h };
}

/** A square-cornered highlight stroke on a halo around the box (DESIGN `callout-box`). */
async function callout(input: string, boxText: string, out: string): Promise<void> {
  const box = parseBox(boxText);
  const image = await load(input);
  if (box.x + box.w > image.width || box.y + box.h > image.height) {
    throw new Error(`the box ${boxText} is outside the ${image.width}x${image.height} image`);
  }
  const stroke = scaled(TOKENS.strokeWidth, image.width);
  const halo = scaled(TOKENS.haloWidth, image.width);
  const highlight = parseColor(TOKENS.highlight);
  const haloColor = parseColor(TOKENS.halo);
  const rect = `x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><rect ${rect} stroke="${haloColor.rgb}" stroke-width="${stroke + 2 * halo}"/><rect ${rect} stroke="${highlight.rgb}" stroke-width="${stroke}"/></svg>`;
  await sharp(image.buffer)
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(out);
}

function required(values: Record<string, string | boolean | undefined>, names: readonly string[]): string[] {
  return names.map((name) => {
    const value = values[name];
    if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} is required`);
    return value;
  });
}

/** Runs one command; resolves the exit code: 0 done, 1 the render failed, 2 a usage error. */
async function main(argv: readonly string[], stderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: { before: { type: 'string' }, after: { type: 'string' }, in: { type: 'string' }, text: { type: 'string' }, box: { type: 'string' }, out: { type: 'string' } },
      strict: true,
    });
    switch (command) {
      case 'composite': {
        const [before, after, out] = required(values, ['before', 'after', 'out']);
        await composite(before!, after!, out!);
        return 0;
      }
      case 'label': {
        const [input, text, out] = required(values, ['in', 'text', 'out']);
        await label(input!, text!, out!);
        return 0;
      }
      case 'callout': {
        const [input, box, out] = required(values, ['in', 'box', 'out']);
        await callout(input!, box!, out!);
        return 0;
      }
      default:
        throw new UsageError(command === undefined ? 'a command is required' : `unknown command ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError || (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') === true) {
      stderr(`antipod-evidence: ${message}\n\n${USAGE}`);
      return 2;
    }
    stderr(`antipod-evidence: ${message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
