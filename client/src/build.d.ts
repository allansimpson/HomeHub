/**
 * The build stamp, substituted into the bundle by Vite at build time.
 *
 * Declared rather than imported because it is not a module — `define` replaces the identifier
 * itself, so there is nothing to import from and nothing to tree-shake. See `vite.config.ts` for
 * what goes into it and why a panel needs to be able to say which build it is.
 *
 * Always carries the build time; carries the commit as well when the build could reach git. A build
 * that shows a time and no commit was made somewhere git would not answer — the build log says which
 * reason — and is still perfectly able to tell you whether a panel is running today's deploy.
 */
declare const __BUILD__: string
