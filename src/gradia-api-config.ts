/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  built-in dependencies  */
import fs   from "node:fs"
import path from "node:path"
import url  from "node:url"

/*  the rendering configuration and its default values  */
export const configDefaults = {
    "font-family":               "Helvetica",
    "font-embed":                false,
    "color-node-regular-name":   "#336699",
    "color-node-regular-box":    "#e0f0ff",
    "color-node-regular-border": "#c0d0e0",
    "color-node-primary-name":   "#ffffff",
    "color-node-primary-box":    "#336699",
    "color-node-primary-border": "#003366",
    "color-node-ghost-name":     "#666666",
    "color-node-ghost-box":      "#f0f0f0",
    "color-node-ghost-border":   "#a0a0a0",
    "color-node-self-name":      "#444444",
    "color-node-self-box":       "#e0e0e0",
    "color-node-self-border":    "#707070",
    "color-group-name":          "#6699cc",
    "color-group-box":           "#f4f8fc",
    "color-group-border":        "#c0d0e0",
    "color-container-name":      "#666666",
    "color-container-box":       "#f6f6f6",
    "color-container-border":    "#a0a0a0",
    "color-edge-line":           "#999999",
    "color-edge-name":           "#333333",
    "color-edge-arity":          "#333333",
    "color-edge-halo":           "#ffffff",
    "color-edge-violation":      "#cc3333",
    "size-font-node":            30,    /*  font size of node names                */
    "size-font-type":            16,    /*  font size of node types                */
    "size-font-prop":            22,    /*  font size of node properties           */
    "size-font-edge":            16,    /*  font size of edge names                */
    "size-font-arity":           16,    /*  font size of edge arities              */
    "size-canvas-margin":        40,    /*  outer margin of the canvas             */
    "size-node-width-min":       220,   /*  minimum node box width                 */
    "size-node-width-max":       0,     /*  maximum node box width (0 = unlimited) */
    "size-node-height-scale":    2.25,  /*  height scale of node boxes             */
    "size-edge-corner-radius":   20,    /*  corner rounding radius of edges        */
    "size-edge-hop-radius":      8,     /*  radius of edge crossing hops           */
    "size-edge-track-gap":       12,    /*  offset between parallel edge routes    */
    "size-edge-track-gap-min":   8,     /*  min offset of crowded parallel routes  */
    "size-edge-port-gap":        24,    /*  max separation of adjacent edge ports  */
    "group-box-padding":         30,    /*  inner padding of group boxes           */
    "group-box-gap":             40,    /*  vertical gap between group boxes       */
    "container-box-padding":     30,    /*  inner padding of container boxes       */
    "graph-columns-max":         4,     /*  graph: max side-by-side nodes          */
    "graph-channel-width-max":   140,   /*  graph: max width of column channels    */
    "graph-channel-width-min":   24,    /*  graph: min width of column channels    */
    "graph-channel-padding":     14,    /*  graph: min gap of a node to its edges  */
    "graph-gutter-height-max":   90,    /*  graph: max height of row gutters       */
    "graph-gutter-height-min":   20,    /*  graph: min height of row gutters       */
    "graph-node-separation":     30,    /*  graph: layered layout node separation  */
    "graph-rank-separation":     60,    /*  graph: layered layout rank separation  */
    "graph-node-degree-max":     3,     /*  graph: max edges/side before growth    */
    "hub-channel-width-max":     340,   /*  hub: max width of column channels      */
    "hub-channel-width-min":     240,   /*  hub: min width of column channels      */
    "hub-node-gap":              20,    /*  hub: vertical gap of stacked nodes     */
    "hub-node-degree-max":       3,     /*  hub: max edges/side before growth      */
    "hub-node-count-max":        0,     /*  hub: max nodes/column before wrapping  */
    "grid-columns-max":          4,     /*  grid: max side-by-side tiles           */
    "grid-columns-min":          3,     /*  grid: min side-by-side tiles           */
    "grid-gap-horizontal":       40,    /*  grid: horizontal gap between tiles     */
    "grid-gap-vertical":         20,    /*  grid: vertical gap between tiles       */
    "grid-node-width-equal":     true,  /*  grid: force equal width of node boxes  */
    "grid-node-height-equal":    true,  /*  grid: force equal height of node boxes */
    "layout-row-cells":          8,     /*  layout: cells per row                  */
    "layout-cell-bits":          8,     /*  layout: bits per cell (1 or 8)         */
    "layout-cell-size":          44,    /*  layout: width and height of a cell     */
    "matrix-cell-size":          44     /*  matrix: width and height of a cell     */
}
export type Config = typeof configDefaults

/*  the configuration options which are directly embedded into the
    generated SVG (and hence can alternatively be provided at display
    time through "--gradia-<option>" CSS custom properties)  */
export type ConfigEmbedded = { [K in keyof Config]: Config[K] extends string ? K : never }[keyof Config]

/*  the font size options, which are embedded into the generated SVG,
    too, but which drive the layout as well and hence are embedded as
    their effective value, still overridable at display time  */
export type ConfigFontSize = "size-font-node" | "size-font-type" |
    "size-font-prop" | "size-font-edge" | "size-font-arity"

/*  resolve a font size option into a CSS value: the effective value is
    the fallback of the CSS custom property "--gradia-<option>", as it
    also sized the layout, so an override should stay close to it  */
export const cssSizeOf = (config: Config, key: ConfigFontSize): string =>
    `var(--gradia-${key}, ${config[key]}px)`

/*  resolve a directly embedded configuration option into a CSS value:
    an explicitly configured value is hard-coded (stripped of the
    characters which would end the CSS declaration, to prevent a CSS
    injection from untrusted values), while otherwise the value is
    fetched at display time from the CSS custom property
    "--gradia-<option>", falling back to the built-in default  */
export const cssValueOf = (explicit: Partial<Config>, key: ConfigEmbedded): string =>
    Object.hasOwn(explicit, key) ?
        explicit[key]!.replace(/[;{}]/g, "") :
        `var(--gradia-${key}, ${configDefaults[key]})`

/*  validate and coerce rendering configuration options into their
    types (coercing strings, as given on the command line): an unknown
    option or an invalid value is rejected, an option set to "undefined"
    is dropped, and an untrusted source may neither embed fonts nor name
    a WOFF2 file, as this would let it read arbitrary local files  */
export const validateConfig = (raw: Record<string, unknown>, options: { trusted: boolean }): Partial<Config> => {
    const config: Record<string, string | boolean | number> = {}
    for (const [ key, val ] of Object.entries(raw)) {
        if (!Object.hasOwn(configDefaults, key))
            throw new Error(`unknown configuration option "${key}"`)
        const k = key as keyof Config
        if (val === undefined)
            continue
        if (k === "font-embed" && !options.trusted)
            throw new Error(`configuration option "${key}" is not available in this context`)
        else if (typeof configDefaults[k] === "boolean") {
            if (typeof val !== "boolean" && val !== "true" && val !== "false")
                throw new Error(`invalid value "${String(val)}" for boolean configuration option "${key}" ` +
                    "(expected \"true\" or \"false\")")
            config[k] = typeof val === "boolean" ? val : val === "true"
        }
        else if (typeof configDefaults[k] === "number") {
            const num = Number(val)
            if ((typeof val !== "number" && typeof val !== "string") || String(val).trim() === "" || !Number.isFinite(num) || num < 0)
                throw new Error(`invalid value "${String(val)}" for numeric configuration option "${key}" ` +
                    "(expected a non-negative number)")
            config[k] = num
        }
        else {
            if (typeof val !== "string")
                throw new Error(`invalid value "${String(val)}" for string configuration option "${key}" (expected a string)`)
            if (val === "")
                throw new Error(`invalid empty value for string configuration option "${key}"`)
            if (k === "font-family" && val.endsWith(".woff2") && !options.trusted)
                throw new Error("configuration option \"font-family\" must not be the path to a WOFF2 file in this context")
            config[k] = val
        }
    }
    return config as Partial<Config>
}

/*  parse "#config <option> <value>" configuration directives from a graph
    description (lines which are otherwise treated as plain comments),
    validating them as untrusted and silently skipping an unknown option
    or an invalid value, as directives never abort the rendering  */
export const parseDirectives = (input: string): Partial<Config> => {
    const partial: Partial<Config> = {}
    for (const line of input.split(/\r?\n/)) {
        const m = /^[ \t]*#config[ \t]+([a-z][a-z0-9-]*)[ \t]+(?:"((?:[^"\\]|\\.)*)"|(\S+))[ \t]*$/.exec(line)
        if (m === null)
            continue
        const val = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]
        try {
            Object.assign(partial, validateConfig({ [m[1]]: val }, { trusted: false }))
        }
        catch {
            /*  skip the invalid directive  */
        }
    }
    return partial
}

/*  the built-in font families, shipped as WOFF2 files by NPM
    dependencies and hence embeddable without any external font file  */
const fontsBuiltIn: Record<string, { file: string, weight: string }> = {
    "Source Sans 3": {
        file:   "source-sans/WOFF2/VF/SourceSans3VF-Upright.ttf.woff2",
        weight: "200 900"
    }
}

/*  read a font file as base64, cached per file path (and revalidated
    by the modification time and the size of the file), as every
    rendered document embeds the very same font (a missing file is
    read uncached, so it raises the very error of the read)  */
const fontCache = new Map<string, { stamp: string, data: string }>()
const fontData = (file: string): string => {
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (stat === undefined)
        return fs.readFileSync(file).toString("base64")
    const stamp = `${stat.mtimeMs}:${stat.size}`
    let   entry = fontCache.get(file)
    if (entry === undefined || entry.stamp !== stamp) {
        entry = { stamp, data: fs.readFileSync(file).toString("base64") }
        fontCache.set(file, entry)
    }
    return entry.data
}

/*  resolve the configured font family: either a built-in font family, a
    plain font family name, or a path to a WOFF2 file (the content of
    the built-in family or the WOFF2 file optionally embedded as base64,
    the former together with the weight range of its variable font)  */
export const resolveFont = (config: Config): { family: string, embed?: string, weight?: string } => {
    const spec = config["font-family"]
    if (Object.hasOwn(fontsBuiltIn, spec)) {
        const builtIn = fontsBuiltIn[spec]
        if (config["font-embed"]) {
            const file = url.fileURLToPath(import.meta.resolve(builtIn.file))
            return { family: spec, embed: fontData(file), weight: builtIn.weight }
        }
        else
            return { family: spec }
    }
    else if (spec.endsWith(".woff2")) {
        const family = path.basename(spec, ".woff2")
        if (config["font-embed"])
            return { family, embed: fontData(spec) }
        else
            return { family }
    }
    else if (config["font-embed"])
        throw new Error("configuration option \"font-embed\" requires configuration option \"font-family\" to be a built-in font " +
            `family (${Object.keys(fontsBuiltIn).map((name) => `"${name}"`).join(", ")}) ` +
            "or the path to a WOFF2 file")
    else
        return { family: spec }
}

