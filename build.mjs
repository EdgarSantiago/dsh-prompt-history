import { build } from 'esbuild'
await build({entryPoints:['client.js'],outfile:'lib/client.js',bundle:true,platform:'browser',format:'iife',target:['es2022'],legalComments:'eof',charset:'utf8',external:['react','react-dom','react/jsx-runtime']})
