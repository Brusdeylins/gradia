/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { ConfigEmbedded, ConfigFontSize } from "./gradia-api-config.js"

/*  a rectangular area, given by its top-left and bottom-right corners  */
type Area = [ number, number, number, number ]

/*  a free-standing drawing primitive of a diagram type beside its node
    boxes and edges (e.g. the lifelines of a "sequence" diagram), styled
    through the regular configuration options (a "path" starts at its
    origin with relative commands only, so it can be shifted, carries
    the area it covers, and is filled only if a fill is given)  */
export interface ShapePath {
    kind:     "path"
    x:        number
    y:        number
    d:        string
    box:      Area
    stroke:   ConfigEmbedded
    width:    number
    dash?:    string
    fill?:    ConfigEmbedded
}

/*  a free-standing single-line text, anchored at its origin on its
    baseline, either with its start or with its end  */
export interface ShapeText {
    kind:     "text"
    x:        number
    y:        number
    text:     string
    anchor:   "start" | "end"
    box:      Area
    fill:     ConfigEmbedded
    size:     ConfigFontSize
}
export type Shape = ShapePath | ShapeText

/*  create a path shape, its covered area given relative to its origin,
    exactly like its relative drawing commands  */
export const pathShape = (x: number, y: number, d: string, [ x1, y1, x2, y2 ]: Area,
    stroke: ConfigEmbedded, width: number, dash?: string, fill?: ConfigEmbedded): ShapePath =>
    ({ kind: "path", x, y, d, box: [ x + x1, y + y1, x + x2, y + y2 ], stroke, width, dash, fill })

/*  create a text shape of the given width and font size, vertically
    centered on its origin  */
export const textShape = (x: number, y: number, text: string, anchor: "start" | "end", w: number,
    fill: ConfigEmbedded, size: ConfigFontSize, fs: number): ShapeText => {
    const x1 = anchor === "start" ? x : x - w
    return { kind: "text", x, y: y + fs * 0.35, text, anchor,
        box: [ x1 - 2, y - fs * 0.6, x1 + w + 2, y + fs * 0.6 ], fill, size }
}

/*  shift a shape by an offset (e.g. into its group box)  */
export const shiftShape = (shape: Shape, dx: number, dy: number): Shape =>
    ({ ...shape, x: shape.x + dx, y: shape.y + dy,
        box: [ shape.box[0] + dx, shape.box[1] + dy, shape.box[2] + dx, shape.box[3] + dy ] })
