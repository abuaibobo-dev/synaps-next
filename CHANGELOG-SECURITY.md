# Synaps hardened source

## Removed

- Telegram collector/relay screen, API routes, service implementation, and GramJS dependency.

## Fixed

- Server listens on loopback only.
- CORS is restricted to localhost origins and origin-less native requests.
- Sensitive settings are masked in API responses and excluded from normal backups.
- Settings loading aborts after six seconds instead of blocking forever.
- Project file access uses path-boundary and symlink-boundary checks.
- Terminal execution requires an explicitly trusted project and rejects arbitrary cwd input.
- Added reproducible pnpm workspace metadata.

## Important

- Rotate any API key that has previously appeared in source, logs, screenshots, or chat.
- The supplied archive did not contain the Android native project, Expo config plugins, or image assets referenced by `client/app.config.ts`; these are required for a real APK build.
