/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Config, ConfigEmbedded, ConfigFontSize } from "./gradia-api-config.js"
import { Area, Layout, ASC, textWidth }           from "./gradia-api-render-base.js"

/*  a free-standing drawing primitive of a diagram type whose content is
    not only made of node boxes and edges (e.g. the cells, braces, and
    rulers of a "layout" diagram), styled exclusively through the very
    same configuration options as the node boxes and edges, so it
    blends seamlessly into the visual language of all other diagrams
    (a "rect" without a fill is an outline only, a "path" starts at its
    origin and continues with relative commands only, so it can be
    shifted, and a "path" and a "text" carry the area they cover, as
    their extent is opaque or depends on the font size)  */
export interface ShapeRect {
    kind:     "rect"
    x:        number
    y:        number
    w:        number
    h:        number
    rx?:      number
    fill?:    ConfigEmbedded
    stroke:   ConfigEmbedded
    width:    number
    dash?:    string
}
export interface ShapePath {
    kind:     "path"
    x:        number
    y:        number
    d:        string
    box:      Area
    stroke:   ConfigEmbedded
    width:    number
    dash?:    string
}
export interface ShapeText {
    kind:     "text"
    x:        number
    y:        number
    text:     string
    box:      Area
    fill:     ConfigEmbedded
    size:     ConfigFontSize | number
    anchor:   "start" | "middle" | "end"
    bold?:    boolean
    url?:     string
    upright?: boolean
}
export type Shape = ShapeRect | ShapePath | ShapeText

/*  the optional presentation of a text shape  */
export interface TextOptions {
    anchor?:  "start" | "middle" | "end"
    bold?:    boolean
    url?:     string
    upright?: boolean
}

/*  create a text shape, estimating the area it covers (from the
    baseline up by one font size and down by a descender), optionally
    "upright", i.e. turned by 90 degrees counter-clockwise, so it runs
    upwards from its anchor point (e.g. a column header)  */
export const textShape = (x: number, y: number, text: string, fill: ConfigEmbedded,
    size: ConfigFontSize | number, config: Config, options: TextOptions = {}): ShapeText => {
    const { anchor = "start", bold = false, url, upright = false } = options
    const px   = typeof size === "number" ? size : config[size]
    const w    = textWidth(text, px, bold)
    const from = anchor === "middle" ? w / 2 : anchor === "end" ? w : 0
    const box: Area = upright ?
        [ x - px, y + from - w, x + px * 0.25, y + from ] :
        [ x - from, y - px, x - from + w, y + px * 0.25 ]
    return { kind: "text", x, y, text, fill, size, anchor, bold, url, upright, box }
}

/*  create a path shape, its covered area given relative to its origin,
    exactly like its relative drawing commands  */
export const pathShape = (x: number, y: number, d: string, [ x1, y1, x2, y2 ]: Area,
    stroke: ConfigEmbedded, width: number, dash?: string): ShapePath =>
    ({ kind: "path", x, y, d, box: [ x + x1, y + y1, x + x2, y + y2 ], stroke, width, dash })

/*  determine the area a shape covers  */
export const shapeBox = (shape: Shape): Area =>
    shape.kind === "rect" ? [ shape.x, shape.y, shape.x + shape.w, shape.y + shape.h ] : shape.box

/*  shift a shape by an offset (e.g. into its group box)  */
export const shiftShape = (shape: Shape, dx: number, dy: number): Shape =>
    shape.kind === "rect" ?
        { ...shape, x: shape.x + dx, y: shape.y + dy } :
        { ...shape, x: shape.x + dx, y: shape.y + dy,
            box: [ shape.box[0] + dx, shape.box[1] + dy, shape.box[2] + dx, shape.box[3] + dy ] }

/*  the layout of a diagram type drawn as shapes only (no node boxes
    and no edges)  */
export const shapeLayout = (shapes: Shape[]): Layout =>
    ({ nodes: [], edges: [], cx: () => 0, cy: () => 0,
        boxW: new Map(), boxH: new Map(), contentH: new Map(), polys: [], shapes })

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

/*  the geometry of a legend, relative to its type font size  */
const LEGEND_LINE  = 1.9   /*  line height of an entry                 */
const LEGEND_SWH   = 1.4   /*  height of a swatch                      */
const LEGEND_SWW   = 40    /*  width of a swatch                       */
const LEGEND_TEXT  = 12    /*  gap between a swatch and its text       */
const LEGEND_BLOCK = 3     /*  margin of a block outline around a cell */
const LEGEND_HEAD  = 10    /*  length of the arrow head of a line      */

/*  create the shapes of a legend, one entry per line, starting at the
    given top-left corner, in the colors and the type font size of the
    diagram (a legend drawn only where the "legend" option is enabled)  */
export const legendShapes = (entries: LegendEntry[], x: number, y: number, config: Config): Shape[] => {
    const shapes: Shape[] = []
    if (!config.legend)
        return shapes
    const fs = config["size-font-type"]
    const lh = Math.round(fs * LEGEND_LINE)
    const sh = Math.round(fs * LEGEND_SWH)
    const sw = LEGEND_SWW
    const m  = LEGEND_BLOCK
    const ah = LEGEND_HEAD
    entries.forEach((entry, k) => {
        const top = y + k * lh
        const mid = top + sh / 2
        if (entry.swatch === "cell" || entry.swatch === "block") {
            shapes.push({ kind: "rect", x, y: top, w: sh, h: sh, fill: "color-node-regular-box",
                stroke: "color-group-border", width: 1 })
            shapes.push(textShape(x + sh / 2, mid + fs * ASC, "1", entry.color, "size-font-type",
                config, { anchor: "middle", bold: true }))
            if (entry.swatch === "block")
                shapes.push({ kind: "rect", x: x - m, y: top - m, w: sh + m * 2, h: sh + m * 2,
                    stroke: entry.color, width: 2, dash: "6 4" })
        }
        else if (entry.swatch === "box") {
            shapes.push({ kind: "rect", x, y: top, w: sw, h: sh, rx: 6, fill: "color-node-regular-box",
                stroke: "color-node-regular-border", width: 2 })
            shapes.push({ kind: "rect", x, y: top, w: sw, h: sh, rx: 6,
                stroke: entry.color, width: 2, dash: "6 4" })
        }
        else {
            shapes.push(pathShape(x, mid, `h ${sw - 4}`, [ 0, -2, sw, 2 ], entry.color, 3, "10 6"))
            shapes.push(pathShape(x + sw - ah, mid - ah * 0.6, `l ${ah} ${ah * 0.6} l ${-ah} ${ah * 0.6}`,
                [ 0, 0, ah, ah * 1.2 ], entry.color, 3))
        }
        shapes.push(textShape(x + sw + LEGEND_TEXT, mid + fs * ASC, entry.text, "color-edge-name",
            "size-font-type", config))
    })
    return shapes
}
