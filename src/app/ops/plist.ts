import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface PlistValues {
  nodePath: string;
  cliPath: string;
  home: string;
}

export function plistTemplatePath(packageRoot: string): string {
  return join(packageRoot, 'launchd', 'com.agxmeister.antipod.plist');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Fills the launchd template's placeholders; every path must be absolute. */
export function renderPlist(template: string, values: PlistValues): string {
  const replacements: Record<string, string> = {
    NODE_PATH: values.nodePath,
    CLI_PATH: values.cliPath,
    ANTIPOD_HOME: values.home,
  };
  for (const [key, value] of Object.entries(replacements)) {
    if (!isAbsolute(value)) {
      throw new Error(`plist value ${key} must be an absolute path, got "${value}"`);
    }
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const value = replacements[key];
    if (value === undefined) {
      throw new Error(`unknown plist placeholder ${match}`);
    }
    return escapeXml(value);
  });
}

/** `antipod plist`: the rendered launchd agent, printed only — never installed. */
export function plistFor(packageRoot: string, values: PlistValues): string {
  return renderPlist(readFileSync(plistTemplatePath(packageRoot), 'utf8'), values);
}
