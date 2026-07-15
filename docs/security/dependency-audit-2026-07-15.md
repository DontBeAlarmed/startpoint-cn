# Dependency audit — 2026-07-15

## Environment

- Node.js: `v20.20.2`
- npm: `10.8.2`
- Policy: exact direct versions, no `npm audit fix --force`, and no accepted high/critical findings.

## Server/root workspace

Before remediation, both the complete audit and `--omit=dev` audit reported 19 findings: 3 low, 7 moderate, 9 high, and 0 critical. Direct high-severity paths included `fastify@5.0.0` and `@fastify/multipart@9.0.0`; `@fastify/static@8.0.0` was a direct moderate path.

The initially drafted target (`fastify@5.8.3`) was not used because it was stale by execution time. The official Fastify release history identifies `5.8.5` as a later security release and `5.10.0` as the current stable release. The official static-plugin compatibility table supports Fastify 5 with plugin versions 8 and newer. The selected exact versions are:

- `fastify@5.10.0`
- `@fastify/multipart@10.1.0`
- `@fastify/static@10.1.0`

Sources:

- [Fastify releases](https://github.com/fastify/fastify/releases)
- [Fastify v5 migration and Node requirement](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)
- [multipart releases](https://github.com/fastify/fastify-multipart/releases)
- [static compatibility and usage](https://github.com/fastify/fastify-static#compatibility)
- [static releases](https://github.com/fastify/fastify-static/releases)

After the exact direct upgrade, a non-forced `npm audit fix` refreshed only compatible transitive versions (including patched `fast-uri`, `tar-fs`, `picomatch`, `postcss`, and related packages). Final results:

| Check | Low | Moderate | High | Critical |
|---|---:|---:|---:|---:|
| `npm audit --omit=dev` | 0 | 0 | 0 | 0 |
| `npm audit` | 0 | 0 | 0 | 0 |

Regression evidence:

- TypeScript typecheck passed.
- Node test suite passed: 38/38.
- Python/mod-tool suite passed: 416 run, 1 skipped.
- Isolated CN smoke on port 18004 passed: unauthenticated management `401`, authenticated management `200`, game asset endpoint `200`, active patch ZIP `200`; the listener and temporary database were removed afterward.

## Admin workspace

Pending the Vite migration batch. This section is completed by the admin dependency upgrade so that the two lockfiles remain independently reviewable.
