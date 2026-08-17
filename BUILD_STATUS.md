# Build status — 3.12.0 hardened

## Passed

- Server TypeScript: passed with zero errors.
- Client TypeScript: passed with zero errors.
- Server TypeScript emit: 50 JavaScript files generated in `server/dist-tsc/`.
- Telegram collector removal scan: no UI, route, service, dependency, or documentation references remain. The database migration intentionally retains only cleanup statements that delete legacy Telegram credentials and tables.

## APK blocker inherited from supplied archive

The supplied archive does not contain these paths referenced by `client/app.config.ts`:

- `client/plugins/withNodeBridge`
- `client/plugins/withDeviceControl`
- `client/assets/images/icon.png`
- `client/assets/images/adaptive-icon.png`
- `client/assets/images/favicon.png`
- `client/assets/images/splash-icon.png`

`withNodeBridge` is the critical native integration that embeds and starts the Node.js backend. Replacing it with a no-op plugin would create an APK whose project, Agent, settings, terminal, tasks, and other API-backed screens cannot work. A production APK must be built from a complete repository containing those native integration files.

## Verification commands

```powershell
node server/node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
node client/node_modules/typescript/bin/tsc --noEmit -p client/tsconfig.json
node server/node_modules/typescript/bin/tsc --noEmit false --outDir server/dist-tsc -p server/tsconfig.json
```
