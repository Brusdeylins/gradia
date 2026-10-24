/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Graph, edgeKinds }                        from "./gradia-api-model.js"
import { parse }                                   from "./gradia-api-parser.js"
import { Config, configDefaults, parseDirectives, validateConfig }
    from "./gradia-api-config.js"
import { partitionGroups, composeGroups }          from "./gradia-api-render-group.js"
import { DiagramTypeSpec, containmentOf, renderContained }
    from "./gradia-api-render-container.js"
import { renderSVG }                               from "./gradia-api-render-svg.js"
import { render as renderGraph }                   from "./gradia-api-type-graph.js"
import { render as renderHub }                     from "./gradia-api-type-hub.js"
import { render as renderGrid }                    from "./gradia-api-type-grid.js"
import { render as renderLayout }                  from "./gradia-api-type-layout.js"
import { render as renderLayer }                   from "./gradia-api-type-layer.js"
import { render as renderMatrix }                  from "./gradia-api-type-matrix.js"
import { render as renderSequence }                from "./gradia-api-type-sequence.js"

/*  re-export the graph model and configuration companion types  */
export type { Attr, Node, Edge, EdgeKind, Graph }  from "./gradia-api-model.js"
export type { Config }                             from "./gradia-api-config.js"

/*  the supported diagram types, their renderers, whether they lay out
    the members of a container, whether they let the edges crossing a
    container boundary continue to the inner nodes, and whether they
    render the edge kinds other than the synchronous default and the
    edge timings  */
const renderers = {
    graph:    { render: renderGraph,    nestable: true,  gated: true,  kinds: false },
    hub:      { render: renderHub,      nestable: true,  gated: false, kinds: false },
    grid:     { render: renderGrid,     nestable: true,  gated: false, kinds: false },
    layout:   { render: renderLayout,   nestable: false, gated: false, kinds: false },
    layer:    { render: renderLayer,    nestable: false, gated: false, kinds: false },
    matrix:   { render: renderMatrix,   nestable: false, gated: false, kinds: false },
    sequence: { render: renderSequence, nestable: false, gated: false, kinds: true  }
} satisfies Record<string, DiagramTypeSpec>
export type DiagramType = keyof typeof renderers
export const diagramTypes = Object.keys(renderers) as DiagramType[]
export const diagramTypeDefault: DiagramType = "graph"

/*  parse the "#type <type>" directive from a graph description (a line
    which is otherwise treated as a plain comment): the last occurrence
    wins and an invalid type is silently skipped, as the directives are
    lines of an untrusted input and never abort the rendering  */
const parseTypeDirective = (input: string): DiagramType | undefined => {
    let type: DiagramType | undefined
    for (const line of input.split(/\r?\n/)) {
        const m = /^[ \t]*#type[ \t]+([a-z][a-z0-9-]*)[ \t]*$/.exec(line)
        if (m === null || !Object.hasOwn(renderers, m[1]))
            continue
        type = m[1] as DiagramType
    }
    return type
}

/*  the options entering the identifier seed only once deviating from
    their default, keeping the identifiers of all older diagrams stable  */
const seedLate = new Set<string>([ "layout-row-cells", "layout-cell-bits", "color-mark-violation",
    "layer-numbered" ])

/*  the supported output formats  */
export const diagramFormats = [ "svg:standalone", "svg:embedded", "url:xml", "url:base64" ] as const
export type DiagramFormat = typeof diagramFormats[number]
export const diagramFormatDefault: DiagramFormat = "svg:standalone"

/*  the diagram rendering options  */
export interface DiagramOptions {
    type?:   DiagramType
    format?: DiagramFormat
    config?: Partial<Config>
}

/*  the Gradia API facade  */
export class Gradia {
    /*  the rendering configuration options and their default values
        (exposed so consumers can discover and validate the options)  */
    static readonly config: Readonly<Config> = Object.freeze({ ...configDefaults })

    /*  parse a graph description into the graph model  */
    static parse (spec: string): Graph {
        return parse(spec)
    }

    /*  generate an SVG document or data URL from a graph model
        (the rendering configuration is layered: defaults, then the
        explicit config options; the directly embedded options become
        hard-coded values when explicitly configured and CSS custom
        property lookups "--gradia-<option>" otherwise)  */
    static async generate (graph: Graph, options: DiagramOptions = {}): Promise<string> {
        /*  determine and validate the diagram type and output format  */
        const type   = options.type ?? diagramTypeDefault
        if (!Object.hasOwn(renderers, type))
            throw new Error(`invalid diagram type "${type}"`)
        const format = options.format ?? diagramFormatDefault
        if (!diagramFormats.includes(format))
            throw new Error(`invalid output format "${format}"`)

        /*  validate and layer the rendering configuration (an option
            explicitly set to "undefined" is dropped, as it would otherwise
            override its default instead of falling back to it)  */
        const explicit = validateConfig(options.config ?? {}, { trusted: true })
        const config   = { ...configDefaults, ...explicit }

        /*  validate the graph model integrity: the map key and the id of
            a node store the same identity (the layout code mixes lookups
            by key and comparisons by id), and every edge endpoint is a
            declared node (the layout code looks up endpoints unchecked)  */
        for (const [ key, node ] of graph.nodes)
            if (node.id !== key)
                throw new Error(`node id "${node.id}" does not match its map key "${key}"`)
        for (const edge of graph.edges)
            for (const id of [ edge.source, edge.target ])
                if (!graph.nodes.has(id))
                    throw new Error(`endpoint "${id}" of edge ` +
                        `"${edge.source}" --> "${edge.target}" is not a declared node`)

        /*  validate the edge kinds and timings: a known kind, and other
            than the synchronous default, as well as any timing, only for
            a diagram type rendering them  */
        for (const edge of graph.edges) {
            const what = `edge "${edge.source}" --> "${edge.target}"`
            if (edge.kind !== undefined && !edgeKinds.includes(edge.kind))
                throw new Error(`invalid kind "${edge.kind}" of ${what}`)
            if (edge.kind !== undefined && edge.kind !== "sync" && !renderers[type].kinds)
                throw new Error(`diagram type "${type}" does not support the kind "${edge.kind}" of ${what}`)
            for (const key of [ "duration", "time" ] as const)
                if (edge[key] !== undefined && !renderers[type].kinds)
                    throw new Error(`diagram type "${type}" does not support the ${key} of ${what}`)
        }

        /*  determine (and validate) the containment tree of the graph  */
        const containment = containmentOf(graph, diagramTypes.filter((t) => renderers[t].nestable))

        /*  lay out the graph model (with its containers as nested
            levels): either as a whole, or partitioned into its named
            groups which are laid out individually and then stacked
            vertically as decorated group boxes  */
        const render = (part: Graph) => renderContained(part, containment, type, renderers, config)
        const parts  = partitionGroups(graph, containment)
        const layout = parts === null ?
            await render(graph) :
            composeGroups(parts, await Promise.all(parts.map((part) => render(part.graph))), config)

        /*  derive the identifier seed of the SVG document from everything
            which determines the rendered output, so that regenerating an
            unchanged diagram yields a byte-identical SVG (the explicitly
            configured options enter as their sorted key list only, as
            their values are already part of the layered configuration and
            merely their presence decides between a hard-coded CSS value
            and a CSS custom property lookup)  */
        const seed = JSON.stringify({
            type,
            config:   Object.fromEntries(Object.entries(config).filter(([ key, val ]) =>
                !seedLate.has(key) || val !== configDefaults[key as keyof Config])),
            explicit: Object.keys(explicit).sort(),
            nodes:    Array.from(graph.nodes.values()),
            edges:    graph.edges
        })

        /*  render the laid out graph into an SVG document  */
        const svg = renderSVG(layout, config, explicit, seed)

        /*  convert the SVG document into the requested output format
            (the Base64 encoding uses the platform-neutral "btoa", as the
            API is also shipped as a browser bundle without "Buffer")  */
        if (format === "svg:embedded")
            return svg.replace(/^<\?xml[^?]*\?>\n/, "")
        else if (format === "url:xml")
            return `data:image/svg+xml,${encodeURIComponent(svg)}`
        else if (format === "url:base64")
            return `data:image/svg+xml;base64,${btoa(Array.from(new TextEncoder().encode(svg),
                (byte) => String.fromCharCode(byte)).join(""))}`
        else
            return svg
    }

    /*  render a graph description into an SVG document or data URL
        (combines parse and generate, with the "#type <type>" and
        "#config <option> <value>" directives from the spec layered
        between the defaults and the explicit options)  */
    static async render (spec: string, options: DiagramOptions = {}): Promise<string> {
        const graph  = Gradia.parse(spec)
        const type   = options.type ?? parseTypeDirective(spec)
        const config = { ...parseDirectives(spec), ...validateConfig(options.config ?? {}, { trusted: true }) }
        return Gradia.generate(graph, { ...options, type, config })
    }
}

