/**
 * The DESIGN.md tokens of generated imagery (AD-20), compiled into the renderer. Sizes are pixels at
 * `referenceWidth` and scale with the width of the image they are drawn on.
 */
export const TOKENS = {
  /** `colors.annotation-plate`: the translucent plate behind every label. */
  plate: '#000000B3',
  /** `colors.annotation-ink`: label text. */
  ink: '#FFFFFF',
  /** `colors.annotation-highlight`: the callout stroke, never a fill. */
  highlight: '#FFD400',
  /** `colors.annotation-halo`: the outer stroke around every callout. */
  halo: '#000000',
  /** `colors.composite-divider`: the gap between the before and after halves. */
  divider: '#FFFFFF',
  /** `typography.annotation-label`. */
  fontFamily: 'Inter',
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
  /** The width `fontSize` and the other sizes are given for. */
  referenceWidth: 1080,
  /** `rounded.annotation`: plate corner radius. */
  radius: 8,
  /** `spacing.annotation-pad`: plate padding and label inset. */
  pad: 12,
  /** `spacing.composite-gap`. */
  gap: 8,
  /** `components.callout-box`. */
  strokeWidth: 4,
  haloWidth: 2,
} as const;

/** A token size scaled to an image `width` wide: at least 1 px. */
export function scaled(value: number, width: number): number {
  return Math.max(1, Math.round((value * width) / TOKENS.referenceWidth));
}

/** `#RRGGBB` or `#RRGGBBAA` as its colour and an opacity in 0..1. */
export function parseColor(hex: string): { rgb: string; opacity: number } {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (match === null) throw new Error(`not a colour token: ${hex}`);
  return { rgb: `#${match[1]!.toUpperCase()}`, opacity: match[2] === undefined ? 1 : parseInt(match[2], 16) / 255 };
}
