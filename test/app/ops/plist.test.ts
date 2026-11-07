import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, packageRoot } from '../../../src/app/cli.ts';
import { plistTemplatePath, renderPlist } from '../../../src/app/ops/plist.ts';
import { createTempHome } from '../../helpers/home.ts';

const template = readFileSync(plistTemplatePath(packageRoot), 'utf8');

describe('antipod plist', () => {
  it('renders the launchd agent with absolute paths', () => {
    const plist = renderPlist(template, { nodePath: '/opt/node/bin/node', cliPath: '/src/antipod/dist/app/cli.js', home: '/Users/o/.antipod-dev', path: '/opt/homebrew/bin:/usr/bin:/bin' });
    expect(plist).toContain('<key>Label</key>\n  <string>com.agxmeister.antipod</string>');
    expect(plist).toContain('<string>/opt/node/bin/node</string>\n    <string>/src/antipod/dist/app/cli.js</string>\n    <string>daemon</string>');
    expect(plist).toContain('<key>ANTIPOD_HOME</key>\n    <string>/Users/o/.antipod-dev</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain('<key>StandardOutPath</key>\n  <string>/Users/o/.antipod-dev/logs/launchd.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>\n  <string>/Users/o/.antipod-dev/logs/launchd.log</string>');
    expect(plist).not.toContain('{{');
  });

  it('escapes XML, rejects relative paths and drops relative PATH entries', () => {
    const rendered = renderPlist(template, { nodePath: '/a&b/node', cliPath: '/c', home: '/h<1>', path: '/x&y:/bin' });
    expect(rendered).toContain('/a&amp;b/node');
    expect(rendered).toContain('<string>/x&amp;y:/bin</string>');
    expect(() => renderPlist(template, { nodePath: 'node', cliPath: '/c', home: '/h', path: '/bin' })).toThrow(/absolute/);
    expect(renderPlist(template, { nodePath: '/n', cliPath: '/c', home: '/h', path: '/bin:./node_modules/.bin::.' })).toContain(
      '<key>PATH</key>\n    <string>/bin</string>',
    );
  });

  it('prints from the CLI for the selected instance and installs nothing', async () => {
    const home = createTempHome();
    const out: string[] = [];
    const code = await main(['plist'], {
      env: { ...home.env, PATH: '/opt/homebrew/bin:/usr/bin' },
      out: (l) => out.push(l),
      err: () => {},
      run: async () => {
        throw new Error('plist must not run commands');
      },
    });
    expect(code).toBe(0);
    const plist = out.join('\n');
    expect(plist).toContain(`<string>${home.root}</string>`);
    expect(plist).toContain(`<string>${join(packageRoot, 'dist', 'app', 'cli.js')}</string>`);
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>');
  });
});
