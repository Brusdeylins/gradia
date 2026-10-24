/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Config, ConfigEmbedded, ConfigFontSize } from "./gradia-api-config.js"
import { textWidth }                              from "./gradia-api-render-base.js"

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
    baseline with its start, its middle, or its end, optionally bold,
    linked, without the halo, or "upright" (turned 90 degrees
    counter-clockwise, so it runs upwards from its origin)  */
export interface ShapeText {
    kind:     "text"
    x:        number
    y:        number
    text:     string
    anchor:   "start" | "middle" | "end"
    box:      Area
    fill:     ConfigEmbedded
    size:     ConfigFontSize | number
    bold?:    boolean
    url?:     string
    halo?:    boolean
    upright?: boolean
}
export type Shape = ShapePath | ShapeText

/*  create a path shape, its covered area given relative to its origin,
    exactly like its relative drawing commands  */
export const pathShape = (x: number, y: number, d: string, [ x1, y1, x2, y2 ]: Area,
    stroke: ConfigEmbedded, width: number, dash?: string, fill?: ConfigEmbedded): ShapePath =>
    ({ kind: "path", x, y, d, box: [ x + x1, y + y1, x + x2, y + y2 ], stroke, width, dash, fill })

/*  create a text shape of the given width and font size, vertically
    centered on its origin (or, upright, horizontally centered on it)  */
export const textShape = (x: number, y: number, text: string, anchor: "start" | "middle" | "end", w: number,
    fill: ConfigEmbedded, size: ConfigFontSize | number, fs: number,
    options: Pick<ShapeText, "bold" | "url" | "halo" | "upright"> = {}): ShapeText => {
    if (options.upright === true) {
        const y1 = anchor === "start" ? y - w : anchor === "end" ? y : y - w / 2
        return { kind: "text", x: x + fs * 0.35, y, text, anchor,
            box: [ x - fs * 0.6, y1 - 2, x + fs * 0.6, y1 + w + 2 ], fill, size, ...options }
    }
    const x1 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2
    return { kind: "text", x, y: y + fs * 0.35, text, anchor,
        box: [ x1 - 2, y - fs * 0.6, x1 + w + 2, y + fs * 0.6 ], fill, size, ...options }
}

/*  create a rectangle shape, as a closed path (filled only if a fill is
    given, and with corners rounded by the radius "r", if given)  */
export const rectShape = (x: number, y: number, w: number, h: number,
    stroke: ConfigEmbedded, width: number, dash?: string, fill?: ConfigEmbedded, r = 0): ShapePath =>
    pathShape(x, y, r > 0 ?
        `m ${r} 0 h ${w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - 2 * r} a ${r} ${r} 0 0 1 ${-r} ${r} ` +
        `h ${2 * r - w} a ${r} ${r} 0 0 1 ${-r} ${-r} v ${2 * r - h} a ${r} ${r} 0 0 1 ${r} ${-r} z` :
        `h ${w} v ${h} h ${-w} z`, [ 0, 0, w, h ], stroke, width, dash, fill)

/*  shift a shape by an offset (e.g. into its group box)  */
export const shiftShape = (shape: Shape, dx: number, dy: number): Shape =>
    ({ ...shape, x: shape.x + dx, y: shape.y + dy,
        box: [ shape.box[0] + dx, shape.box[1] + dy, shape.box[2] + dx, shape.box[3] + dy ] })

/*  an entry of the legend below a diagram, explaining a mark by a
    swatch drawn like it: a "cell" (a numbered cell), a "block" (a
    dashed cell outline), a "box" (a dashed node box), or a "line"  */
export interface LegendEntry {
    swatch: "cell" | "block" | "box" | "line"
    color:  ConfigEmbedded
    text:   string
}

/*  create the shapes of a legend, one entry per line, from the given top-left corner on  */
export const legendShapes = (entries: LegendEntry[], x: number, y: number, config: Config): Shape[] => {
    const shapes: Shape[] = []
    const fs = config["size-font-type"]
    const lh = Math.round(fs * 1.9)  /*  line height of an entry                  */
    const sh = Math.round(fs * 1.4)  /*  height of a swatch                       */
    const sw = 40                    /*  width of a swatch                        */
    const tg = 12                    /*  gap between a swatch and its text        */
    const m  = 3                     /*  margin of a block outline around a cell  */
    const ah = 10                    /*  length of the arrow head of a line       */
    entries.forEach((entry, k) => {
        const top = y + k * lh
        const mid = top + sh / 2
        if (entry.swatch === "cell" || entry.swatch === "block") {
            shapes.push(rectShape(x, top, sh, sh, "color-container-border", 1, undefined, "color-node-regular-box"))
            shapes.push(textShape(x + sh / 2, mid, "1", "middle", textWidth("1", fs, true), entry.color,
                "size-font-type", fs, { bold: true, halo: false }))
            if (entry.swatch === "block")
                shapes.push(rectShape(x - m, top - m, sh + m * 2, sh + m * 2, entry.color, 2, "6 4"))
        }
        else if (entry.swatch === "box") {
            shapes.push(rectShape(x, top, sw, sh, "color-node-regular-border", 2, undefined, "color-node-regular-box", 6))
            shapes.push(rectShape(x, top, sw, sh, entry.color, 2, "6 4", undefined, 6))
        }
        else {
            shapes.push(pathShape(x, mid, `h ${sw - 4}`, [ 0, -2, sw, 2 ], entry.color, 3, "10 6"))
            shapes.push(pathShape(x + sw - ah, mid - ah * 0.6, `l ${ah} ${ah * 0.6} l ${-ah} ${ah * 0.6}`,
                [ 0, 0, ah, ah * 1.2 ], entry.color, 3))
        }
        shapes.push(textShape(x + sw + tg, mid, entry.text, "start", textWidth(entry.text, fs), "color-edge-name",
            "size-font-type", fs))
    })
    return shapes
}
