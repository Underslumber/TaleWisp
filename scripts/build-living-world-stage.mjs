import { build } from '../vendor/worldx/client/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
import { copyFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ configFile: false, root, logLevel: 'warn', resolve: { alias: { phaser: fileURLToPath(new URL('../web-client/stage/phaser.ts', import.meta.url)) } },
 build: { outDir: 'web-client/public/vendor', emptyOutDir: false, minify: true, sourcemap: false,
 lib: { entry: fileURLToPath(new URL('../web-client/stage/living-world-stage.ts', import.meta.url)), formats: ['es'], fileName: () => 'living-world-stage.js' },
 rollupOptions: { output: { inlineDynamicImports: true } } } });
copyFileSync(new URL('../vendor/worldx/client/node_modules/phaser/LICENSE.md', import.meta.url),new URL('../web-client/public/vendor/PHASER-LICENSE.txt', import.meta.url));
copyFileSync(new URL('../vendor/worldx/LICENSE', import.meta.url),new URL('../web-client/public/vendor/WORLDX-LICENSE.txt', import.meta.url));
