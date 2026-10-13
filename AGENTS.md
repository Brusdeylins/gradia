## About

**gradia** is the opinionated tooling of *Dr. Ralf S. Engelschall*
for *Object Graph Diagram Rendering*: a small CLI for rendering
directed graphs, described in a concise textual input language, as SVG
diagrams. Seven diagram types are supported: `graph` (a grid-snapped
layered layout of the whole graph, based on the Dagre algorithm of
`@antv/layout`), `hub` (a hub graph, placing one primary hub node
between its input and output nodes), `grid` (a compact grid of
tiles for an edge-less graph), `layout` (the cell layout of a
binary structure, its nodes being fields with an `offset` and a `size`),
`layer` (a layered architecture, its layers stacked as bands and
the edges against the layering marked as violations), `matrix` (a
dependency structure matrix, its cycles outlined as blocks), and
`sequence` (a sequence diagram of participants and their messages).

## Repository Layout

-   `src/`: the TypeScript sources
    -   `src/gradia-cli.ts`: the Commander-based CLI (thin wrapper over the API)
    -   `src/gradia-mcp.ts`: the MCP service on stdio (the
        `gradia_render` tool, wrapping the API `render` method)
    -   `src/gradia-api.ts`: the API facade class `Gradia` (static
        methods `parse`, `generate`, and the combined `render`), wiring
        parser, configuration, group partitioning, container nesting,
        the per-type renderers, and the SVG output, plus the re-exported
        companion types (`Graph`, `Node`, `Edge`, `Attr`, `Config`)
    -   `src/gradia-api-model.ts`: the graph model types (`Attr`, `Node`, `Edge`, `Graph`)
    -   `src/gradia-api-parser.ts`: the input language parser, producing the graph model
    -   `src/gradia-api-config.ts`: the rendering options (defaults,
        in-input directive parsing, font resolution)
    -   `src/gradia-api-render-base.ts`: shared rendering geometry/font
        constants (e.g. the arrow head room `arrowRoom` every diagram
        type keeps free in front of an arrow head), the `Layout` handed
        over for SVG generation, text width measurement (bold-aware),
        text word-wrapping, text template filling, and the shared
        raster step `RASTER` (`onRaster`), onto which every diagram type
        with node boxes rounds their sizes, unified per lane: per grid
        column (width) and row (box height) for `graph`, per column for
        `hub`, across the whole diagram (width) and per layer (height) for
        `layer` (a uniform `graph` layout), per tile for `grid` (and
        across all tiles, if equalized by its options), and across all
        participants for `sequence`, where `graph` and `hub` grow a box
        with many edge attachments individually afterwards, again onto
        the raster
    -   `src/gradia-api-render-shape.ts`: the free-standing `Shape`
        primitives (`rect`, `path`, `text`) a diagram type draws beside
        or instead of node boxes and edges, styled through the same
        configuration options, their helpers, and the legend below a
        diagram explaining its marks
    -   `src/gradia-api-render-node.ts`: node box text line breaking,
        measurement, ordering, outline shape geometry, and styling helpers
    -   `src/gradia-api-render-edge.ts`: edge routing (port/track
        assignment, polyline simplification, hop computation, SVG path
        generation)
    -   `src/gradia-api-render-group.ts`: group partitioning of the
        graph and composition of the per-group layouts
    -   `src/gradia-api-render-container.ts`: container nesting
        (`parent`/`container` attributes): the containment tree, the
        recursive per-level layout with container placeholders and
        boundary gate nodes, and the stitching of the boundary-crossing
        edges
    -   `src/gradia-api-render-svg.ts`: the final SVG document generation from a `Layout`
    -   `src/gradia-api-type-graph.ts`: the `graph` diagram type (layered
        layout via the Dagre algorithm of `@antv/layout`)
    -   `src/gradia-api-type-hub.ts`: the `hub` diagram type (hub graph layout)
    -   `src/gradia-api-type-grid.ts`: the `grid` diagram type (compact grid layout)
    -   `src/gradia-api-type-layout.ts`: the `layout` diagram type (the
        cells, ruler, braces, and labels of a binary structure, drawn as
        shapes only)
    -   `src/gradia-api-type-layer.ts`: the `layer` diagram type (an
        explicitly ordered `graph` with uniformly sized boxes and evenly
        spaced gutters, one row per layer, plus the layer
        bands as shapes and the violating edges marked through the
        per-edge `marked` flags of the `Layout`)
    -   `src/gradia-api-type-matrix.ts`: the `matrix` diagram type (the
        headers and cells of a dependency structure matrix, drawn as
        shapes only, the cycles found as the strongly connected
        components of the graph)
    -   `src/gradia-api-type-sequence.ts`: the `sequence` diagram type
        (the participants as node boxes, the messages as edges, and the
        lifelines as shapes)
-   `etc/`: the tool configurations (`eslint.mjs`, `tsconfig.json`,
    `stx.conf`, `vite.ts`)
-   `smp/`: the sample graph descriptions (`*.txt`), their rendered
    SVG outputs (`*.svg`), and the playground (`playground.html`)
-   `dst/`: the compiled output (`bin` `gradia` is `dst/gradia-cli.js`,
    the browser UMD bundle of the API is `dst/gradia-api.umd.js`)
    -- never edit it; it is regenerated

## Build System

Build orchestration uses `@rse/stx`, not plain npm scripts. The only npm
script is `npm start`, which invokes stx with `etc/stx.conf`:

```
npm start build         # lint + build-cmd + build-web
npm start build-cmd     # tsc --project etc/tsconfig.json (emits into dst/)
npm start build-web     # vite --config etc/vite.ts build (emits dst/gradia-api.umd.js)
npm start lint          # eslint --config etc/eslint.mjs src/*.ts
npm start build-watch   # nodemon rebuild on src/**/*.ts
npm start lint-watch    # nodemon relint on src/**/*.ts
npm start sample        # render the smp/*.txt samples into smp/*.svg
npm start clean         # remove regularly built files
npm start distclean     # also remove node_modules and package-lock.json
```

No test target is defined.

## CLI Command

```
gradia [-t graph|hub|grid|layout|layer|matrix|sequence] [-f <format>] [-c <name>=<value>] [-o <file>.svg] <graph>.txt
```

The output format is `svg:standalone` (a standalone SVG/XML document,
the default), `svg:embedded` (the SVG without the `<?xml?>` declaration,
for direct embedding into HTML), `url:xml` (a `data:image/svg+xml` URL
with URL-encoded XML), or `url:base64` (a `data:image/svg+xml` URL with
Base64-encoded XML).

The diagram type is either given through the `--type` command-line
option or through a `#type <type>` directive inside the input, with the
command-line option taking precedence (the built-in default is `graph`).

With `--mcp`, the CLI instead runs as an MCP service on stdio (and then
accepts neither the input argument nor `--output`), exposing the single
tool `gradia_render` with the arguments `input`, `type`, `format`,
and `config`, whose description carries the entire input language
grammar and the recognized rendering options. The `--type`, `--format`,
and `--config` command-line options act as the defaults underlying the
tool call arguments. As the tool call arguments are untrusted, their
`config` rejects `font-embed` and WOFF2 `font-family` values, exactly
like the in-input `#config` directives do.

All identifiers inside the generated SVG are namespaced with a
`gradia-<uuid>-` prefix, derived per rendered document, so that multiple
diagrams can be embedded into one and the same document without
colliding in the DOM-global identifier namespace. The `<uuid>` is the
Base16 form of a UUID v5 (via `pure-uuid`) over everything which
determines the rendered output -- the diagram type, the layered
configuration, and the graph model -- so regenerating an unchanged
diagram yields a byte-identical SVG.

The rendering options (`font-family`, `font-embed`, the `color-*`
family, the geometry families `size-*`, `group-*`, `container-*`,
`graph-*`, `hub-*`, `grid-*`, `layout-*`, `layer-*`, `matrix-*`, and
`sequence-*`, the `legend` switch, and the `legend-*` texts) are set
through the repeatable `--config <name>=<value>` command-line option,
or through `#config
<option> <value>` directives inside the input, except `font-embed` and
WOFF2 file paths, which are command-line-only, as the input is treated
as untrusted. The `font-family` and `color-*` options are embedded into
the SVG as CSS values: explicitly configured values are hard-coded, all
others become `var(--gradia-<option>, <default>)` CSS custom property
lookups resolvable by the embedding document (precedence: explicit
config, then CSS `--gradia-<option>`, then the built-in default).

The `font-family` option is either a built-in font family, a plain font
family name, or the path to a WOFF2 file. The only built-in font family
is `Source Sans 3`, the variable upright WOFF2 file of the NPM
dependency `source-sans`, which under `font-embed` is base64-embedded
into the SVG (with a `font-weight: 200 900` descriptor for its weight
axis) and hence requires no external font file at all.

## Code Style

Strict TypeScript conventions are enforced in `src/`: no semicolons
(except inside `for`), double quotes, K&R braces, no braces around
single-statement `if`/`while` blocks, vertically-aligned operators
on similar consecutive lines, `/* ... */` block comments with two
leading/trailing spaces, parens around all arrow parameters, and line
breaks before `else`/`catch`/`finally`. Match existing formatting
exactly when editing.
