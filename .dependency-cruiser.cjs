/**
 * AD-1 layering, enforced by `pnpm lint`.
 * Paths are relative to the directory depcruise runs in (the repo root, or a fixture root in tests).
 * TypeScript is parsed with swc: dependency-cruiser cannot use the TypeScript 7 compiler API.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'core-allowed-imports',
      comment: 'src/core/ imports only Node built-ins, zod and other core/ modules (AD-1).',
      severity: 'error',
      from: { path: '^src/core/' },
      to: {
        dependencyTypesNot: ['core'],
        pathNot: ['^src/core/', '(^|/)node_modules/zod/', '(^|/)node_modules/\\.pnpm/zod@[^/]+/node_modules/zod/'],
      },
    },
    {
      name: 'domain-imports-nothing-up',
      comment: 'core/domain/ imports neither ports/ nor coordinator/ (domain <- ports <- coordinator).',
      severity: 'error',
      from: { path: '^src/core/domain/' },
      to: { path: '^src/core/(ports|coordinator)/' },
    },
    {
      name: 'ports-import-nothing-up',
      comment: 'core/ports/ imports domain/ only, never coordinator/ (domain <- ports <- coordinator).',
      severity: 'error',
      from: { path: '^src/core/ports/' },
      to: { path: '^src/core/coordinator/' },
    },
    {
      name: 'no-adapter-to-adapter',
      comment: 'An adapter never imports another adapter (AD-1).',
      severity: 'error',
      from: { path: '^src/adapters/([^/]+)/' },
      to: { path: '^src/adapters/', pathNot: '^src/adapters/$1/' },
    },
    {
      name: 'no-adapter-to-app',
      comment: 'Adapters import core/, never the composition root in app/ (AD-1).',
      severity: 'error',
      from: { path: '^src/adapters/' },
      to: { path: '^src/app/' },
    },
  ],
  options: {
    parser: 'swc',
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.d\\.ts$' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.json'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
