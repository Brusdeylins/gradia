/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge }             from "./gradia-api-model.js"
import { Config, ConfigEmbedded, ConfigFontSize } from "./gradia-api-config.js"

/*  rendering font size constant of the group tags (the font sizes of
    the node and edge texts and the further geometry are configurable,
    see the "size-*" and per-diagram-type options in the configuration)  */
export const FS_GROUP = 24   /*  font size of group tags       */

/*  the raster step the unified node box sizes of the diagram types
    arranging their boxes in lanes (columns or rows) are rounded up to  */
export const RASTER = 20

/*  the setback of an edge arity label from the arrow head it annotates
    (shared by the SVG rendering and the graph channel sizing)  */
export const ARITY_OFF = 24

/*  the offset of an edge arity label from its own edge line, and the
    rendered height of an arrow head (the 21px marker of the SVG
    covering 8 of the 10 units of its own viewBox)  */
export const ARITY_PAD = 4
export const ARROW_H   = 17

/*  the straight run an edge keeps between its arrow head and a corner
    or a hop in front of it (at its end and likewise at its start), and
    hence the room an arrow head claims along its edge, so neither a
    corner nor a hop ever touches the arrow head  */
export const ARROW_AIR = 8
export const arrowRoom = (config: Config): number =>
    ARROW_H + config["size-edge-corner-radius"] + ARROW_AIR

/*  the gap between the arity label and the name label of an edge
    placed side by side in front of its arrow head  */
export const ARITY_GAP = 8

/*  the straight run an edge entering its node (or a bundle entering or
    leaving its node through one merged port) keeps between its track
    and the node box: the setback of the arity from the arrow head, the
    arity label and the name label of the edge (both placed there, side
    by side above the line), and the corner and some air in front  */
export const stubRoom = (edge: Edge, config: Config): number =>
    ARITY_OFF + (edge.arity !== undefined ? textWidth(edge.arity, config["size-font-arity"]) + ARITY_GAP : 0) +
    textWidth(edge.name ?? "", config["size-font-edge"]) + ARROW_AIR + config["size-edge-corner-radius"]

/*  the height of the box an edge arity label occupies  */
export const arityHeight = (config: Config): number =>
    Math.round(config["size-font-arity"] * 0.8)

/*  estimate rendered text width (no canvas available under Node,
    factor tuned for the average glyph advance of Source Sans 3)  */
export const textWidth = (text: string, size: number): number =>
    text.length * size * 0.52

/*  greedily wrap a text into the lines fitting a maximum rendered width
    (a word exceeding the width on its own is kept unbroken, as breaking
    inside a word harms the readability more than an overlong box)  */
export const textWrap = (text: string, size: number, maxWidth: number): string[] => {
    const words = text.split(/\s+/).filter((word) => word !== "")
    const norm  = words.join(" ")
    if (maxWidth <= 0 || words.length <= 1 || textWidth(norm, size) <= maxWidth)
        return [ norm ]
    const lines: string[] = []
    let line = words[0]
    for (const word of words.slice(1)) {
        if (textWidth(`${line} ${word}`, size) > maxWidth) {
            lines.push(line)
            line = word
        }
        else
            line = `${line} ${word}`
    }
    lines.push(line)
    return lines
}

/*  escape a string for use in XML/SVG content (control and non-characters
    are stripped, as XML forbids them even in their escaped form)  */
export const escapeXML = (text: string): string =>
    text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF\p{Cs}]/gu, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")

/*  an orthogonal edge polyline  */
export type Poly = [ number, number ][]

/*  the node box coloring (given as configuration option keys which
    are resolved into CSS color values at SVG generation time)  */
export interface NodeStyle {
    fill:   ConfigEmbedded
    stroke: ConfigEmbedded
    text:   ConfigEmbedded
    dash?:  string
}

/*  a decorated group box surrounding the nodes of a named group  */
export interface GroupBox {
    name: string
    x:    number
    y:    number
    w:    number
    h:    number
}

/*  a decorated container box surrounding the members of a container node  */
export interface ContainerBox {
    node: Node
    x:    number
    y:    number
    w:    number
    h:    number
}

/*  a free-standing drawing primitive of a diagram type whose content is
    not only made of node boxes and edges (e.g. the cells, braces, and
    rulers of a "layout" diagram), styled exclusively through the very
    same configuration options as the node boxes and edges, so it
    blends seamlessly into the visual language of all other diagrams
    (a "path" starts at its origin and continues with relative commands
    only, so it can be shifted, and a "path" and a "text" carry the area
    they cover, as their extent is opaque or depends on the font size)  */
export interface ShapeRect {
    kind:    "rect"
    x:       number
    y:       number
    w:       number
    h:       number
    rx?:     number
    fill:    ConfigEmbedded
    stroke:  ConfigEmbedded
    width:   number
    dash?:   string
}
export interface ShapePath {
    kind:    "path"
    x:       number
    y:       number
    d:       string
    box:     Area
    stroke:  ConfigEmbedded
    width:   number
    dash?:   string
}
export interface ShapeText {
    kind:    "text"
    x:       number
    y:       number
    text:    string
    box:     Area
    fill:    ConfigEmbedded
    size:    ConfigFontSize | number
    anchor:  "start" | "middle" | "end"
    bold?:   boolean
    url?:    string
    upright?: boolean
}
export type Shape = ShapeRect | ShapePath | ShapeText

/*  a rectangular area, given by its top-left and bottom-right corners  */
export type Area = [ number, number, number, number ]

/*  create a text shape, estimating the area it covers (from the
    baseline up by one font size and down by a descender), optionally
    "upright", i.e. turned by 90 degrees counter-clockwise, so it runs
    upwards from its anchor point (e.g. a column header)  */
export const textShape = (x: number, y: number, text: string, fill: ConfigEmbedded,
    size: ConfigFontSize | number, config: Config, anchor: "start" | "middle" | "end" = "start",
    bold = false, url?: string, upright = false): Shape => {
    const px   = typeof size === "number" ? size : config[size]
    const w    = textWidth(text, px)
    const from = anchor === "middle" ? w / 2 : anchor === "end" ? w : 0
    const box: Area = upright ?
        [ x - px, y + from - w, x + px * 0.25, y + from ] :
        [ x - from, y - px, x - from + w, y + px * 0.25 ]
    return { kind: "text", x, y, text, fill, size, anchor, bold, url, upright, box }
}

/*  determine the area a shape covers  */
export const shapeBox = (shape: Shape): Area =>
    shape.kind === "rect" ? [ shape.x, shape.y, shape.x + shape.w, shape.y + shape.h ] : shape.box

/*  shift a shape by an offset (e.g. into its group box)  */
export const shiftShape = (shape: Shape, dx: number, dy: number): Shape =>
    shape.kind === "rect" ?
        { ...shape, x: shape.x + dx, y: shape.y + dy } :
        { ...shape, x: shape.x + dx, y: shape.y + dy,
            box: [ shape.box[0] + dx, shape.box[1] + dy, shape.box[2] + dx, shape.box[3] + dy ] }

/*  the laid out graph handed over for SVG generation (the optional
    "bundled" flags run parallel to the edges and the polylines and
    mark the edges sharing a track with others, as flags compose by
    concatenation exactly like the edges themselves, across groups and
    containment levels alike, the optional "junctions" are the points
    at which those edges join or leave the shared track, and the
    optional "crowded" flag marks a layout with crowded channels or
    gutters)  */
export interface Layout {
    nodes:       Node[]
    edges:       Edge[]
    cx:          (id: string) => number
    cy:          (id: string) => number
    boxW:        Map<string, number>
    boxH:        Map<string, number>
    contentH:    Map<string, number>
    polys:       Poly[]
    styleOf?:    (node: Node) => NodeStyle
    groups?:     GroupBox[]
    containers?: ContainerBox[]
    shapes?:     Shape[]
    violates?:   (edge: Edge) => boolean
    bundled?:    boolean[]
    junctions?:  Poly
    crowded?:    boolean
}

/*  an entry of the legend below a diagram, explaining one kind of mark
    by a swatch drawn like the mark itself: a "cell" (a matrix cell with
    its number), a "block" (a dashed square, like the outline of a
    cycle), a "box" (a node box outlined dashed, like a gap), or a
    "line" (a dashed edge line with its arrow head)  */
export interface LegendEntry {
    swatch: "cell" | "block" | "box" | "line"
    color:  ConfigEmbedded
    text:   string
}

/*  create the shapes of a legend, one entry per line, starting at the
    given top-left corner, in the colors and the type font size of the
    diagram (a legend drawn only where the "legend" option is enabled)  */
export const legendShapes = (entries: LegendEntry[], x: number, y: number, config: Config): Shape[] => {
    const shapes: Shape[] = []
    if (!config.legend)
        return shapes
    const fs = config["size-font-type"]
    const lh = Math.round(fs * 1.9)
    const sw = 40
    const sh = Math.round(fs * 1.4)
    entries.forEach((entry, k) => {
        const top = y + k * lh
        const mid = top + sh / 2
        if (entry.swatch === "cell" || entry.swatch === "block") {
            shapes.push({ kind: "rect", x, y: top, w: sh, h: sh, fill: "color-node-regular-box",
                stroke: "color-group-border", width: 1 })
            shapes.push(textShape(x + sh / 2, mid + fs * 0.36, "1", entry.color, "size-font-type",
                config, "middle", true))
            if (entry.swatch === "block")
                shapes.push({ kind: "path", x: x - 3, y: top - 3, d: `h ${sh + 6} v ${sh + 6} h ${-sh - 6} z`,
                    box: [ x - 3, top - 3, x + sh + 3, top + sh + 3 ], stroke: entry.color, width: 2, dash: "6 4" })
        }
        else if (entry.swatch === "box") {
            shapes.push({ kind: "rect", x, y: top, w: sw, h: sh, rx: 6, fill: "color-node-regular-box",
                stroke: "color-node-regular-border", width: 2 })
            shapes.push({ kind: "path", x, y: top, d: `h ${sw} v ${sh} h ${-sw} z`,
                box: [ x, top, x + sw, top + sh ], stroke: entry.color, width: 2, dash: "6 4" })
        }
        else {
            shapes.push({ kind: "path", x, y: mid, d: `h ${sw - 4}`, box: [ x, mid - 2, x + sw, mid + 2 ],
                stroke: entry.color, width: 3, dash: "10 6" })
            shapes.push({ kind: "path", x: x + sw - 10, y: mid - 6, d: "l 10 6 l -10 6",
                box: [ x + sw - 10, mid - 6, x + sw, mid + 6 ], stroke: entry.color, width: 3 })
        }
        shapes.push(textShape(x + sw + 12, mid + fs * 0.36, entry.text, "color-edge-name", "size-font-type", config))
    })
    return shapes
}

