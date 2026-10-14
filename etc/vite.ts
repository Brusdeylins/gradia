/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

import { defineConfig, Plugin } from "vite"

/*  stub the Node-only built-ins in the browser bundle (they are only
    touched by the WOFF2 font file resolution, which is unreachable in
    the browser, as "font-embed" is a command-line-only option, and by
    the native SHA-1 of the identifier derivation, which falls back to
    pure-uuid in the browser)  */
const stubs: Record<string, string> = {
    "node:crypto": "export default {}",
    "node:fs":     "export default {}",
    "node:url":    "export default { fileURLToPath: (u) => u }",
    "node:path":   "export default { basename: (p, e) => { " +
                   "const b = p.replace(/^.*\\//, \"\"); " +
                   "return e !== undefined && b.endsWith(e) ? b.slice(0, b.length - e.length) : b } }"
}
const nodeStubs = (): Plugin => ({
    name: "node-stubs",
    resolveId: (id: string) => Object.hasOwn(stubs, id) ? `\0stub:${id}` : null,
    load: (id: string) => id.startsWith("\0stub:") ? stubs[id.slice(6)] : null
})

export default defineConfig(() => ({
    base: "",
    root: ".",
    plugins: [ nodeStubs() ],

    /*  stub the ESM-only module resolution of the built-in font files,
        too, as "import.meta" does not exist in the UMD output format  */
    define: { "import.meta.resolve": "((spec) => spec)" },
    build: {
        outDir:       "dst",
        emptyOutDir:  false,
        lib: {
            name:     "Gradia",
            entry:    "./src/gradia-api.ts",
            formats:  [ "umd" ],
            fileName: () => "gradia-api.umd.js"
        }
    }
}))
