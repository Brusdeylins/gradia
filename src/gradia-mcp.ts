/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  external dependencies  */
import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z }                    from "zod"

/*  internal dependencies  */
import { Config, configDefaults, validateConfig }         from "./gradia-api-config.js"
import { Gradia, DiagramType, diagramTypes, diagramTypeDefault,
    DiagramFormat, diagramFormats, diagramFormatDefault } from "./gradia-api.js"

/*  the rendering configuration options offered to the MCP client
    ("font-embed" is intentionally omitted, as the arguments of a tool
    call are treated as untrusted and it would allow the reading of
    arbitrary local WOFF2 files)  */
const configOptions = Object.entries(configDefaults)
    .filter(([ key ]) => key !== "font-embed")
    .map(([ key, val ]) => `  - "${key}" (${typeof val}, default: ${JSON.stringify(val)})`)
    .join("\n")

/*  the comprehensive description of the "gradia_render" tool, teaching
    the AI the complete input language and the available parameters  */
const toolDescription = `
Render a directed object graph, described in the concise textual Gradia input
language, into an SVG diagram. Use this to visualize object graphs, class and
component relationships, data flows, dependency graphs, and similar structures.

## Diagram Types

- "graph": a loosely grid-snapped layered layout of the whole graph. This is
  the general-purpose type and the built-in default. It accepts any topology,
  including self-loops and free-standing nodes.
- "hub": a hub graph, placing the single primary node (the node carrying the
  attribute "primary: true") in the center, its input nodes to the left and
  its output nodes to the right. It accepts only the constrained topology
  described below.
- "grid": a compact grid of tiles for an edge-less graph. The nodes are placed
  in declaration order onto a roughly square, row-major grid.
- "layout": the cell layout of a binary structure (e.g. a message frame, a file
  header, or a memory slot): every node is a field drawn as a run of cells
  below a ruler and labeled below the cells.
- "layer": a layered architecture: the layers (the "layer: <name>" attribute of
  the nodes) stack top-down as bands, and an edge pointing upwards against the
  layering is marked as a violation.
- "matrix": a dependency structure matrix: the nodes are rows and columns, a
  cell counts the edges from its row to its column, and the cycles are outlined
  as blocks on the diagonal.
- "sequence": a sequence diagram: the nodes are the participants on top of
  their lifelines, and the edges are the messages, top-down in declaration order.

### Diagram Type Constraints

The "hub" type rejects the input with an error unless all of the following
conditions hold:

- Exactly one node carries the attribute "primary: true".
- Every edge either points to or originates from that primary node. An edge
  between two non-primary nodes is rejected.
- Every non-primary node is an input or an output of the primary node, i.e.,
  no node is free-standing.

A node which is both an input and an output of the primary node is placed
twice, once in the input column and once in the output column. The second
placement is rendered as a dashed "ghost" box, colored by the
"color-node-ghost-*" options.

A self-loop on the primary node is unrolled: the primary node is placed a
second time on top of the output column, as the target of the self-loop.
This second placement is rendered as a dashed "self" box, colored by the
(darker grey) "color-node-self-*" options.

The "grid" type rejects the input with an error as soon as the graph contains
at least one edge.

The diagram type "layout" rejects the input with an error as soon as the
graph contains at least one edge or one container. Every node is a field
of the binary structure and has to carry the attributes "offset" and
"size" (non-negative and positive integers, decimal or "0x" hexadecimal),
both counted in cells of "layout-cell-bits" bits each, where a "size" of
"*" denotes a variable size, drawn up to the end of its row and marked
as continuing by a trailing "..." of its label. The fields are drawn in
rows of "layout-row-cells" cells below a ruler of the cell numbers, a
field exceeding its row continues in the next one, overlapping fields
are rejected, and the cells between the fields are drawn as dashed gaps.
A layout spans at most 4096 cells and "layout-row-cells" is at most
256, as every cell becomes several elements of the drawing.
Every field is labeled below its cells through a brace (or, for a single
cell, a tick), where the labels of narrow neighboring fields stagger
downwards, connected by a leader line. The optional attribute "value"
shows a fixed value inside the cells: one character (code point) per
cell, if it has exactly as many characters as the field has cells (e.g. the bits of a
marker), else once across the merged cells of the field (e.g. a magic
number). The attributes "url" (on the label) and "primary" (the primary
cell colors) are honored, and the "group" attribute stacks several
structures as group boxes, while all other attributes are ignored. The
offset of every row is shown right beside it, in hexadecimal bytes
(or in bits, where a row does not start on a byte boundary).

The diagram type "layer" lays out a layered architecture and rejects
the input with an error as soon as the graph contains a container. The
attribute "layer: <name>" assigns a node to a layer, the layers stack
top-down in the order of their first appearance as bands spanning the
whole diagram (colored by the "color-container-*" options, the layer name
left of its nodes), and the nodes of a layer fill its band
left-to-right (wrapped beyond "graph-columns-max" nodes), while the nodes
without a layer trail outside of any band. An edge pointing from a lower
layer to a higher one, i.e. against the layering, is drawn dashed in the
"color-mark-violation" color, as it marks a violation of the layering.
The attribute "layer-group: <path>" assigns the layer of a node to nested
groups ("/"-separated, outermost first, e.g. "Server/Broker"), which are
drawn as columns left of the bands, spanning the bands of their layers,
with their names running upwards (the layers of a group are kept
together, and all nodes of a layer have to name the same path), and
the option "layer-numbered" numbers the layers top-down. All node boxes
take the width of the widest one and the boxes of a layer the height of
the highest one, so the boxes line up across the layers.

The diagram type "sequence" draws a sequence diagram and rejects the
input with an error as soon as the graph contains a container: the nodes
(in declaration order, or in the order of their "order" attributes) are
the participants, drawn as regular node boxes side by side (all of the
size of the largest one) on top of their dashed lifelines, and the edges
are the messages, drawn as regular edges with their names and arities
between the lifelines, top-down in declaration order, where an edge from
a node to itself loops on its own lifeline. The option
"sequence-message-gap" sets the vertical distance of the messages.

The diagram type "matrix" draws a dependency structure matrix (DSM) and
rejects the input with an error as soon as the graph contains a
container. The nodes are both its rows and its columns (in declaration
order, or in the order of their "order" attributes), the row and
column headers carrying the node labels in boxes of the node box colors
(linked through "url"), lying and upright. A matrix reads from a row to
its columns: the cell of row X and column Y carries the number of edges
from X to Y (their summed numeric arities), i.e. how often X depends on Y, the diagonal is shaded, and every cycle, i.e. every set of
nodes reaching each other through their edges, is moved into
consecutive rows and outlined as a dashed block on the diagonal, with
the numbers of its edges in the "color-mark-violation" color.

As soon as a node carries the attribute "axis: column", the "matrix" is a
traceability matrix instead: the "axis: column" nodes are its columns and all
other nodes its rows, a cell counts the edges between its row and its
column in either direction (as a trace may be recorded on either side,
e.g. a test case referencing the requirement it verifies), there is no
diagonal and no cycle, and a row or column without any entry is marked
as a gap by a header outlined dashed in the "color-mark-violation" color,
or, if the node carries the attribute "trace: indirect" (as it relates to
the other side indirectly only, e.g. a test case verifying a rule which
constrains a requirement), in the "color-mark-warning" color.

In both forms the type shared by all rows, and the one shared by all
columns (their "type" attributes), become their titles in the corner
above the row headers and left of the column headers.

The diagram types marking violations or gaps ("layer" and "matrix") explain the
marks actually shown in a legend below the diagram (plus, for a
"matrix", the meaning of its cell numbers), which the "legend" option
disables and the "legend-*" options reword (e.g. to localize them),
where "{row}" and "{column}" stand for the row and column titles of a
matrix, and "{item}" and "{other}" for the title of the marked side and
the one of the other side (falling back to the texts of "legend-row"
and "legend-column").

The "graph" type imposes no such constraints and hence is the safe choice
whenever the topology is not known to fit "hub" or "grid" (and is no binary
structure for "layout").

## Input Language

The "input" argument is a plain-text graph description: one node/edge chain per
line, plus optional comments and rendering directives.

### Grammar

The following BNF grammar describes the input syntax. Non-terminals are written
as <name>, terminals as "...", optional parts as [ ... ], repeatable parts as
{ ... } (zero or more times), and alternatives are separated by |.

    <graph>          ::= { <statement> | <newline> }
    <statement>      ::= <node> { <edge> <node> } ( <newline> | <eof> )
    <node>           ::= <atom> [ ":" <atom> ] [ <attributes> ]
    <attributes>     ::= "[" <attribute> { "," <attribute> } "]"
    <attribute>      ::= <atom> ":" <atom>
    <edge>           ::= "--" [ "(" <edge-name> ")" "--" ] ">" [ "[" <edge-arity> "]" ]
    <edge-name>      ::= <string> | <name-word>
    <edge-arity>     ::= <string> | <arity-word>
    <atom>           ::= <bareword> | <string>
    <bareword>       ::= <bareword-char> { <bareword-char> }
    <bareword-char>  ::= <char> - ( <whitespace> | "[" | "]" | "(" | ")" | "," | ":" | "\\"" | ">" | "#" )
    <name-word>      ::= <name-char> { <name-char> }
    <name-char>      ::= <char> - ( <whitespace> | "(" | ")" | "\\"" )
    <arity-word>     ::= <arity-char> { <arity-char> }
    <arity-char>     ::= <char> - ( <whitespace> | "[" | "]" | "\\"" )
    <string>         ::= "\\"" { <string-char> } "\\""
    <string-char>    ::= ( <char> - ( "\\"" | "\\\\" | <newline> ) ) | ( "\\\\" ( <char> - <newline> ) )
    <comment>        ::= "#" { <char> - <newline> }
    <directive>      ::= "#config" <whitespace> { <whitespace> } <option> <whitespace> { <whitespace> } ( <string> | <word> )
                       | "#type" <whitespace> { <whitespace> } <type>
    <option>         ::= <letter> { <letter> | <digit> | "-" }
    <type>           ::= "graph" | "hub" | "grid" | "layout" | "layer" | "matrix" | "sequence"
    <word>           ::= <char> - <whitespace> { <char> - <whitespace> }
    <newline>        ::= "\\n"
    <whitespace>     ::= " " | "\\t" | "\\r"

### Lexical Rules

- A <bareword> must not contain the character sequence "--" at any position, as
  "--" always starts an edge operator.
- An <edge> is a single lexical token: no whitespace and no comment is allowed
  anywhere inside it, especially not between ">" and "[".
- Whitespace (except <newline>) is insignificant between all other tokens and
  never part of a token.
- A <newline> terminates a <statement>: statements cannot span multiple lines.
- A <comment> starts at an unquoted "#" and extends to the end of the line.
  Inside a <string>, "#" is an ordinary character.
- A <string> cannot span lines. Inside it, "\\" escapes the following character.
- A <directive> is a <comment> which occupies its entire line and starts with
  the keyword "#config" or "#type". All other comments are ignored.
- Of multiple "#type" directives the last one wins, and a directive naming an
  invalid type is silently ignored. A "#config" directive naming an unknown
  option or carrying an invalid value is silently ignored, too, whereas the
  same mistake in the "config" tool argument is rejected with an error.

### Semantic Rules

- In <node>, the first <atom> is the node id and the optional <atom> after ":"
  is the displayed node label. Without a label, the id is displayed.
- A node can be referenced multiple times. All references address the same node
  and merge their label and attributes into it, with later values overriding
  earlier ones for the same attribute key.
- Nodes which are never part of an <edge> are rendered free-standing.
- In a chain "a --> b --> c", each <edge> connects its immediately preceding and
  following node, i.e., the chain is equivalent to "a --> b" and "b --> c".
- The <edge-name> is rendered as the label of the edge and the <edge-arity> as
  its cardinality label.
- Eight attribute keys are reserved and consumed by the renderer instead of
  being displayed as a regular "<key>: <val>" line (beside the ones the
  individual diagram types reserve, see above):
  - "url: <url>" renders the node box as a hyperlink. Only relative URLs and
    the schemes "http", "https", and "mailto" are honored; any other URL is
    silently dropped and the node box then simply stays unlinked,
  - "type: <name>" renders <name> as a smaller text above the node label,
  - "primary: true" renders the node in the primary node colors (and, for the
    diagram type "hub", marks the single central hub node). The value has to
    be the literal string "true",
  - "group: <name>" places the node into the surrounding group box <name>,
  - "parent: <id>" nests the node into the container node <id> (a node which
    is implicitly declared if never referenced otherwise),
  - "container: <type>" marks the node as a container whose members are laid
    out with the diagram type <type> ("graph", "hub", or "grid"), even if it
    has no members at all,
  - "order: <number>" places the node explicitly (see below),
  - "shape: <shape>" draws the node box with another outline (see below).
- A "graph" (a "graph" container level, too) with at least one node carrying an
  "order" attribute is laid out in that explicit order instead of by the layered
  algorithm: the distinct order values become the rows, top-down in ascending
  order, the nodes of one value fill their row left-to-right in declaration
  order (wrapped into further rows beyond "graph-columns-max" nodes), and the
  nodes without an order follow in the trailing rows. A "grid" places its tiles
  in the order of the attribute, too, the tiles without one trailing. Use it to
  impose a reading order (e.g. the order of a document), which lets every
  reference to an earlier item point upward or leftward.
- A node cannot be a member of more than one group. As soon as at least one node
  carries a "group" attribute, all nodes without one implicitly belong to the
  group "default", and every edge has to stay within a single group. A nested
  node belongs to the group of its outermost container.
- The groups are laid out individually with the selected diagram type and then
  stacked vertically as decorated group boxes. For the type "hub" this means
  that every single group needs its own primary node.
- A node referenced as the "parent" of another node is a container: it is
  rendered as a dashed grey box surrounding its members instead of as a node
  box, with its label, "type", and "url" in the box head (its remaining
  attributes are not rendered). Containers nest to any depth, but a node cannot
  be a member of more than one container, and cannot be nested into itself.
- The members of a container are laid out as a diagram of their own, with the
  diagram type of the enclosing level unless overridden by "container: <type>",
  and the container then takes part in the layout of the enclosing level as a
  single box. Edges may connect any two nodes, across container boundaries and
  to container nodes themselves, except a container with one of its own
  members. An edge crossing the boundary of a container laid out as "graph" is
  routed through the box border to the inner node (entering on the west and
  leaving on the east side), while an edge crossing the boundary of a container
  laid out as "hub" or "grid" ends at the box border instead. The diagram type
  constraints apply to every container level (e.g., a "hub" container needs its
  own primary node, and a "grid" container permits no edges among its members).
- Use containers (not groups) to visualize zones, tiers, deployment units, or
  packages whose members are connected to the outside world.
- The attribute "shape: <shape>" draws the node box with another
  outline, keeping its colors and its text, where the outline claims
  the additional room it needs around the text: "box" (the
  default), "database" (a cylinder), "queue" (a lying cylinder), "cloud"
  (a cloud), "stack" (the box stacked onto two copies of itself, for
  several instances), "person" (a box with a person badge on its top
  border), or "device" (a box with a device badge), where an unknown
  shape is ignored.
- All remaining attributes are displayed as "<key>: <val>" lines inside the node
  box.

### Example Input

    #type   graph

    #config color-node-primary-box  #336699
    #config color-edge-line         #999999

    Animal: animal [ type: "abstract class", kind: base, url: "#animal", primary: true ]
    Dog: dog [ parent: Pets ]
    Cat: cat [ parent: Pets ]
    Pets: "Domestic Pets" [ type: package ]

    Dog --(isa)--> Animal
    Cat --(isa)--> Animal
    "Pet Owner" --(owns)-->[0..*] Dog --(chases)-->[0..n] Cat

## Rendering Configuration

The optional "config" argument sets rendering options, equivalent to the
"#config <option> <value>" directives inside the input, but taking precedence
over them. The recognized options, with their types and built-in defaults, are:

${configOptions}

The "size-*", "group-*", "container-*", "graph-*", "hub-*", "grid-*",
"layout-*", "layer-*", "matrix-*", and "sequence-*" options control the
rendering geometry (canvas margin, node box sizing, edge routing, group and
container box spacing, and the per-diagram-type layout) and take
non-negative numbers, except the booleans "grid-node-width-equal" and
"grid-node-height-equal", which force all node boxes of a "grid" diagram to
the width of the widest one and to the height of the tallest one (a nested
container box taking part in the width unification only), and
"layer-numbered". The boolean "legend" enables the legend below a diagram
marking violations or gaps, and the "legend-*" options are the non-empty
texts of its entries.

The "size-node-width-max" option additionally enables the word-wrapping of the
node box texts: given a positive value, the node name, its type, and its
attribute lines are greedily broken at whitespace, so that the node box stays
within the given width and grows in height instead. This is the only way to
produce multi-line node boxes. The default "0" disables the wrapping entirely
and hence lets a node box become as wide as its longest text. A single word
wider than the maximum is never broken and still widens the box beyond it.

The "grid-columns-min" and "grid-columns-max" options control the column count
of a "grid" diagram, which by default is derived from the node count as a
roughly square grid: "grid-columns-min" (default 3) raises the derived count,
so that a few nodes still share a single row instead of being stacked, while
"grid-columns-max" (default 4) caps it, so that larger diagrams grow in height
only. The column count never exceeds the node count and the maximum always
wins over the minimum.

The "layout-row-cells", "layout-cell-bits", and "layout-cell-size" options
control a "layout" diagram: the number of cells per row, the number of bits a
cell stands for (usually 1 for bit fields or 8 for byte fields), and the width
and height of a cell.

The "font-family" and "color-*" options are embedded into the generated SVG:
when such an option is not explicitly configured, the SVG instead references
the CSS custom property "--gradia-<option>" (definable by an embedding HTML
document) and falls back to the built-in default. Leave them unset unless a
particular look is explicitly requested.

The "font-family" option is either the built-in font family "Source Sans 3" or
a plain font family name resolved by the displaying document. A path to a
WOFF2 file is rejected in this context, exactly like the option "font-embed":
both are available only through the (trusted) command-line options of the
service.

## Result

The tool returns the rendered diagram as a single text result, in the requested
output format. For the "svg:*" formats this is the SVG/XML document, which is
usually written to a "*.svg" file; for the "url:*" formats it is a
"data:image/svg+xml" URL, usable as the "src" of an HTML "<img>" element.

On a malformed input, a violated diagram type constraint, or an invalid "config"
argument, the tool instead returns an error result whose text starts with
"gradia: ERROR: ", followed by the reason.
`.trim()

/*  the defaults of the MCP service, provided by the (trusted)
    command-line and underlying the arguments of every tool call  */
export interface MCPDefaults {
    type?:   DiagramType
    format?: DiagramFormat
    config?: Partial<Config>
}

/*  the arguments of the "gradia_render" tool (with their descriptions
    reflecting the service defaults underlying the arguments)  */
const toolArgumentsOf = (defaults: MCPDefaults) => ({
    input: z.string()
        .describe("The graph description in the Gradia input language (see the tool description for its grammar)."),
    type: z.enum(diagramTypes).optional()
        .describe("The diagram type. Takes precedence over a \"#type\" directive inside the input. " +
            (defaults.type !== undefined ?
                `Defaults to "${defaults.type}".` :
                `Defaults to the "#type" directive of the input, else to "${diagramTypeDefault}".`)),
    format: z.enum(diagramFormats).optional()
        .describe("The output format: \"svg:standalone\" (a standalone SVG/XML document), " +
            "\"svg:embedded\" (the SVG without the \"<?xml?>\" declaration, for embedding into HTML), " +
            "\"url:xml\" (a \"data:image/svg+xml\" URL with URL-encoded XML), or " +
            "\"url:base64\" (a \"data:image/svg+xml\" URL with Base64-encoded XML). " +
            `Defaults to "${defaults.format ?? diagramFormatDefault}".`),
    config: z.record(z.string(), z.union([ z.string(), z.number(), z.boolean() ])).optional()
        .describe("The rendering configuration options (see the tool description for their names, " +
            "types, and defaults). Takes precedence over the \"#config\" directives inside the input.")
})

/*  run the MCP service on stdio  */
export const serve = async (meta: { version: string }, defaults: MCPDefaults = {}) => {
    /*  establish the MCP server and its single tool  */
    const server = new McpServer({
        name:    "gradia",
        title:   "Gradia -- Object Graph Diagram Rendering",
        version: meta.version
    })
    server.registerTool("gradia_render", {
        title:       "Render an object graph as an SVG diagram",
        description: toolDescription,
        inputSchema: toolArgumentsOf(defaults),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const config = { ...defaults.config, ...validateConfig(args.config ?? {}, { trusted: false }) }
            const out    = await Gradia.render(args.input, {
                type:   args.type   ?? defaults.type,
                format: args.format ?? defaults.format,
                config
            })
            return { content: [ { type: "text" as const, text: out } ] }
        }
        catch (err: unknown) {
            return {
                isError: true,
                content: [ { type: "text" as const,
                    text: `gradia: ERROR: ${err instanceof Error ? err.message : String(err)}` } ]
            }
        }
    })

    /*  connect the MCP server to the stdio transport  */
    await server.connect(new StdioServerTransport())
}

