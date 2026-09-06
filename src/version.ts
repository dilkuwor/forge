import pkg from '../package.json' with { type: 'json' };

/** Package version; inlined at bundle time by tsup and bun. */
export const VERSION: string = (pkg as { version?: string }).version || '0.0.0';
