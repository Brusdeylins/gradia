/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Attr, Node }                              from "./gradia-api-model.js"
import { Config }                                  from "./gradia-api-config.js"
import { NodeStyle, textWidth, textWrap }
    from "./gradia-api-render-base.js"

/*  the special "primary" annotation (rendered as a distinct node coloring)  */
export const isPrimary = (node: Node): boolean =>
    node.attrs.findLast((attr) => attr.key === "primary")?.val === "true"

/*  the default node box coloring (primary node boxes get a distinct one)  */
export const defaultStyleOf = (node: Node): NodeStyle =>
    isPrimary(node) ? {
        fill:   "color-node-primary-box",
        stroke: "color-node-primary-border",
        text:   "color-node-primary-name"
    } : {
        fill:   "color-node-regular-box",
        stroke: "color-node-regular-border",
        text:   "color-node-regular-name"
    }

/*  the special "type" annotation (rendered above the node name)  */
export const typeOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "type")?.val

/*  the special "parent" annotation (nesting the node into a container node)  */
export const parentOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "parent")?.val

/*  the special "container" annotation (the diagram type laying out the
    members of the node, marking even a member-less node as a container)  */
export const containerTypeOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "container")?.val

/*  container box head geometry (the head holds the name tag and the
    optional type line above it)  */
export const HEAD_H = 34  /*  height of the container box head        */
export const HEAD_T = (config: Config): number =>
    config["size-font-type"] + 4  /*  extra head height of a type line  */
export const containerHead = (node: Node, config: Config): number =>
    HEAD_H + (typeOf(node) !== undefined ? HEAD_T(config) : 0)

/*  the special "order" annotation (the explicit top-down placement
    order of the node, a finite number, an invalid value being ignored)  */
export const orderOf = (node: Node): number | undefined => {
    const val = node.attrs.findLast((attr) => attr.key === "order")?.val
    const num = val !== undefined && val.trim() !== "" ? Number(val) : NaN
    return Number.isFinite(num) ? num : undefined
}

/*  sort the nodes by their "order" annotations, the ones without one
    trailing, and otherwise keep their declaration order (the sort is
    stable, and the "|| 0" turns the NaN of two trailing nodes, the
    difference "Infinity - Infinity", into a tie)  */
export const byOrder = (nodes: Node[]): Node[] =>
    nodes.toSorted((a, b) => (orderOf(a) ?? Infinity) - (orderOf(b) ?? Infinity) || 0)

/*  the special attributes consumed by the renderers instead of being
    rendered as node box text lines  */
const ATTRS_SPECIAL = new Set([ "url", "type", "primary", "group", "parent", "container", "order", "shape" ])

/*  the special "shape" annotation (the outline of the node box, which
    keeps the colors and the text layout of a regular box): "box" (the
    default), "database" (a cylinder), "queue" (a lying cylinder),
    "cloud" (a cloud), "stack" (a box stacked onto copies of itself, for
    several instances), "person" (a box with a person badge), or
    "device" (a box with a device badge), an unknown value being ignored  */
export const nodeShapes = [ "box", "database", "queue", "cloud", "stack", "person", "device" ] as const
export type NodeShape = typeof nodeShapes[number]
export const QUEUE_RX  = 16  /*  horizontal radius of the caps of a lying cylinder   */
export const STACK_OFF = 12  /*  offset of the rearmost copy behind a stack front    */
export const BADGE_R   = 13  /*  radius of the badge on the top border of a box      */
export const shapeOf = (node: Node): NodeShape => {
    const val = node.attrs.findLast((attr) => attr.key === "shape")?.val
    return nodeShapes.find((shape) => shape === val) ?? "box"
}

/*  the extent a node occupies above its box: the upper half of the
    badge of a "person" or "device" plus some clearance  */
export const badgeExtent = (node: Node): number =>
    [ "person", "device" ].includes(shapeOf(node)) ? BADGE_R + 2 : 0

/*  split the attributes rendered as text lines from the special ones  */
export const attrsOfNode = (node: Node): Attr[] =>
    node.attrs.filter((attr) => !ATTRS_SPECIAL.has(attr.key))

/*  the special "url" attribute (rendered as a hyperlink on the whole node
    box, restricted to relative URLs and safe schemes, as the generated
    SVG anchor would otherwise execute an injected "javascript:" URL)  */
const URL_SCHEME = /^\s*([A-Za-z][A-Za-z0-9+.-]*):/
const URL_SAFE   = new Set([ "http", "https", "mailto" ])
export const urlOf = (node: Node): string | undefined => {
    const raw = node.attrs.findLast((attr) => attr.key === "url")?.val
    if (raw === undefined)
        return undefined

    /*  strip control characters, as browsers remove them before
        resolving the URL and they would otherwise hide an unsafe scheme  */
    const url    = raw.replace(/[\u0000-\u001F\u007F]/g, "")
    const scheme = URL_SCHEME.exec(url)
    if (scheme !== null && !URL_SAFE.has(scheme[1].toLowerCase()))
        return undefined
    return url
}

/*  node box text metrics (shared by the measuring and the text
    placement), where the vertical ones track the font size of the text
    they space out, so that a configured font size never lets a line
    collide with its neighbor  */
export const PAD_W  = 18  /*  left/right node box text padding          */
export const ATTR_P = 12  /*  top padding of the attribute block        */
export const ATTR_B = 20  /*  bottom padding of the attribute block     */

/*  minimum node box height (one name line plus its vertical padding)  */
export const MIN_H = (config: Config): number =>
    config["size-font-node"] + 26

/*  height of an additional name line  */
export const NAME_H = (config: Config): number =>
    config["size-font-node"] + 4

/*  height of a single attribute line  */
export const ATTR_H = (config: Config): number =>
    config["size-font-prop"] + 8

/*  extra height of a single type line  */
export const TYPE_H = (config: Config): number =>
    config["size-font-type"] + 10

/*  baseline distance of the type line to the name line (the cap height
    of the name plus the line box of the type)  */
export const TYPE_D = (config: Config): number =>
    config["size-font-node"] * 0.72 + config["size-font-type"] * 0.90

/*  the text lines rendered inside a node box  */
export interface NodeLines {
    name:  string[]
    type:  string[]
    attrs: string[]
}

/*  break the textual content of a node into its rendered lines, word-wrapped
    to the configured maximum box width (shared by the measuring and the text
    placement, so both can never disagree on the resulting line count)  */
export const linesOfNode = (node: Node, config: Config): NodeLines => {
    const max  = config["size-node-width-max"] > 0 ?
        config["size-node-width-max"] - PAD_W * 2 : 0
    const type = typeOf(node)
    return {
        name:  textWrap(node.name, config["size-font-node"], max),
        type:  type !== undefined ? textWrap(type, config["size-font-type"], max) : [],
        attrs: attrsOfNode(node).flatMap((attr) =>
            textWrap(`${attr.key}: ${attr.val}`, config["size-font-prop"], max))
    }
}

/*  determine node box sizes from their textual content (boxes are
    scaled up in height by a per-node factor, but never below the
    content height, to give the edges more attachment room), except
    for the nodes of a fixed size (the container placeholders and gate
    nodes of a containment level), which are taken as given  */
export const measureNodes = (
    nodes:   Node[],
    config:  Config,
    scaleOf: (node: Node) => number,
    fixed?:  Map<string, { w: number, h: number }>
): { boxW: Map<string, number>, boxH: Map<string, number>, contentH: Map<string, number> } => {
    /*  the resulting node box dimensions  */
    const boxW     = new Map<string, number>()
    const boxH     = new Map<string, number>()
    const contentH = new Map<string, number>()

    /*  measure the text content of every node  */
    for (const node of nodes) {
        const size = fixed?.get(node.id)
        if (size !== undefined) {
            boxW.set(node.id, size.w)
            boxH.set(node.id, size.h)
            contentH.set(node.id, size.h)
            continue
        }
        const lines = linesOfNode(node, config)
        const w = Math.max(0,
            ...lines.name.map((line)  => textWidth(line, config["size-font-node"])),
            ...lines.type.map((line)  => textWidth(line, config["size-font-type"])),
            ...lines.attrs.map((line) => textWidth(line, config["size-font-prop"])))
        const h = MIN_H(config) + (lines.name.length - 1) * NAME_H(config) +
            lines.type.length * TYPE_H(config) +
            (lines.attrs.length > 0 ? ATTR_P + (lines.attrs.length - 1) * ATTR_H(config) + ATTR_B : 0)
        const bw = Math.max(config["size-node-width-min"], Math.ceil(w) + PAD_W * 2)
        const bh = Math.max(h, Math.ceil(h * scaleOf(node)))

        /*  an outline other than a box claims additional room around the
            text: the caps of a cylinder, the bulges of a cloud, the
            copies behind the front box of a stack  */
        const shape = shapeOf(node)
        boxW.set(node.id, shape === "queue" ? bw + QUEUE_RX * 2 + PAD_W :
            shape === "cloud" ? Math.ceil(bw * 1.2) : shape === "stack" ? bw + STACK_OFF : bw)
        boxH.set(node.id, shape === "database" ? Math.ceil(bh * 1.5) :
            shape === "cloud" ? Math.ceil(bh * 1.4) : shape === "stack" ? bh + STACK_OFF : bh)
        contentH.set(node.id, h)
    }
    return { boxW, boxH, contentH }
}

