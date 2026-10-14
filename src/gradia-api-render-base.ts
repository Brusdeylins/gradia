/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge }             from "./gradia-api-model.js"
import { Config, ConfigEmbedded } from "./gradia-api-config.js"
import type { Shape }             from "./gradia-api-render-shape.js"

/*  rendering font size constant of the group tags (the font sizes of
    the node and edge texts and the further geometry are configurable,
    see the "size-*" and per-diagram-type options in the configuration)  */
export const FS_GROUP = 24   /*  font size of group tags       */

/*  the raster step every diagram type rounds its unified node box
    sizes up to, so the boxes of a lane (a column or a row) are of equal
    size and their texts line up  */
export const RASTER = 20
export const onRaster = (n: number): number =>
    Math.ceil(n / RASTER) * RASTER

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
    factor tuned for the average glyph advance of Source Sans 3, a bold
    text widened by the heavier advance of its glyphs)  */
const BOLD = 1.1
export const textWidth = (text: string, size: number, bold = false): number =>
    text.length * size * 0.52 * (bold ? BOLD : 1)

/*  the ascender ratio: the distance of the baseline of a text below the
    vertical center of its line, relative to its font size, so a text
    drawn at "center + size * ASC" sits vertically centered  */
export const ASC = 0.36

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

/*  fill the "{name}" placeholders of a text template with their values
    (through a replacer function, as a replacement string would treat
    the "$&" and alike inside a value as substitution patterns), keeping
    an unknown placeholder as it is  */
export const fillTemplate = (template: string, vars: Record<string, string>): string =>
    template.replace(/\{([a-z]+)\}/g, (match, name: string) => Object.hasOwn(vars, name) ? vars[name] : match)

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

/*  a rectangular area, given by its top-left and bottom-right corners  */
export type Area = [ number, number, number, number ]

/*  the laid out graph handed over for SVG generation (the optional
    "marked" flags run parallel to the edges and the polylines and mark
    the edges violating a rule of their diagram type, e.g. pointing
    upwards in a layered diagram, as flags compose by concatenation
    exactly like the edges themselves, across groups and containment
    levels alike, the optional "bundled" flags run parallel to them,
    too, and mark the edges sharing a track with others, the optional
    "junctions" are the points at which those edges join or leave the
    shared track, the optional "crowded" flag marks a layout with
    crowded channels or gutters, and the optional "centered" flag marks
    a layout whose edge names stay centered on their routes, e.g. the
    messages of a sequence diagram, instead of being placed in front of
    their arrow heads)  */
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
    marked?:     boolean[]
    bundled?:    boolean[]
    junctions?:  Poly
    crowded?:    boolean
    centered?:   boolean
}
