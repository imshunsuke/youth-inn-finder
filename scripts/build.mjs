// esbuild is bundled with the pinned Wrangler development toolchain. The site
// still ships plain browser JavaScript, with no third-party runtime dependency.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const output='public/app.bundle.js';
const result=await build({entryPoints:['public/app.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'none',write:false});
const text=result.outputFiles[0].text;
if(process.argv.includes('--check')) {
  if(await readFile(output,'utf8')!==text) throw new Error('Browser bundle is stale. Run npm run build.');
} else await writeFile(output,text);
