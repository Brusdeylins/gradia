/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  external dependencies  */
import UUID                                                 from "pure-uuid"

/*  internal dependencies  */
import { Node, Edge }                                       from "./gradia-api-model.js"
import { Config, ConfigEmbedded, ConfigFontSize, resolveFont, cssValueOf, cssSizeOf }
    from "./gradia-api-config.js"
import { Poly, NodeStyle, Layout, GroupBox, ContainerBox,
    FS_GROUP, ARITY_OFF, ARITY_PAD, arityHeight, textWidth, escapeXML }
    from "./gradia-api-render-base.js"
import { linesOfNode, urlOf, typeOf, defaultStyleOf, containerHead,
    MIN_H, NAME_H, ATTR_H, ATTR_P, TYPE_H, TYPE_D, HEAD_H }
    from "./gradia-api-render-node.js"
import { computeHops, pathOf, pointAt }
    from "./gradia-api-render-edge.js"

/*  escape a string for use inside a CSS string literal (the XML escaping
    is resolved by the parser before the CSS is parsed, so quotes and
    backslashes have to be neutralized to prevent a CSS injection, and
    the CSS newline characters LF, CR and FF have to be replaced, as
    they would end the string literal as an invalid "bad string")  */
const escapeCSS = (text: string): string =>
    text.replace(/[\\"']/g, "\\$&").replace(/[\r\n\f]/g, " ")

/*  the UUID namespace of Gradia, under which the per-document
    identifier prefixes are derived  */
const NS_GRADIA = new UUID(5, "ns:URL", "https://github.com/rse/gradia").format()

/*  derive a per-document identifier prefix from a seed, as the SVG
    identifiers are DOM-global and would collide once multiple diagrams
    are embedded into the very same document. The prefix is derived from
    the UUID v5 of the seed and hence stays stable across regenerations
    of an unchanged diagram (the Base16 format keeps it alphanumeric and
    thus a valid XML name and CSS/URL fragment, and its leading 12 digits
    keep the identifiers short, as every edge references one, while
    still making a collision among the diagrams of a document unlikely)  */
const idPrefix = (seed: string): string =>
    `gradia-${new UUID(5, NS_GRADIA, seed).format("b16").toLowerCase().slice(0, 12)}`

/*  the styling of the rendered elements: instead of repeating the very
    same lengthy style on every element, the elements reference CSS
    classes, which the document declares once. A class is named after
    the UUID v5 of its own declarations, so equal declarations share
    one class, even across the diagrams embedded into the very same
    document, where the class names are global (and where the embedding
    document hence can declare all classes once on its own)  */
interface Styler {
    text: (fill: ConfigEmbedded, size: ConfigFontSize | number,
        options?: { bold?: boolean, middle?: boolean, halo?: boolean }) => string
    box:  (fill: ConfigEmbedded, stroke: ConfigEmbedded, width: number) => string
}

/*  a rectangular area, given by its top-left and bottom-right corners  */
type Box = [ number, number, number, number ]

/*  the placement of a group tag in the top-left corner of its group box  */
const TAG_DX = 18  /*  left offset of the group tag  */
const TAG_DY = 12  /*  top offset of the group tag   */

/*  the half width of the box an edge line segment occupies  */
const LINE_PAD = 2

/*  the clearance a label keeps from a foreign edge line, as a label
    merely not overlapping such a line still reads as its annotation  */
const LINE_GAP = 12

/*  the gap between two arity labels set back one behind the other along
    one and the same edge line, and the number of such setbacks tried  */
const ARITY_STEP = 8
const ARITY_BACK = 3

/*  the edge length of the uniform grid buckets indexing the edge lines  */
const BUCKET = 64

/*  the maximum number of steps a name label is slid along a single
    segment of its route, as a long segment would otherwise offer far
    more candidate positions than a placement can ever need  */
const SLIDE_MAX = 16

/*  track occupied areas (node boxes and already placed labels) to
    let subsequent labels dodge into a collision-free position, plus the
    areas merely reserved for the labels still to be placed, and the
    edge lines (their segments and crossing hops) to let the labels at
    least prefer the position covering the fewest lines (the returned
    "occupied" array grows with every claimed label box and hence also
    serves as the box input of the overall bounding box)  */
const labelPlacer = (
    layout:    Layout,
    hops:      Map<number, number[]>[],
    hopRadius: number,
    config:    Config
): {
    claim:    (candidates: Box[], edge: number, dodge?: boolean, own?: Box) => Box,
    reserve:  (box: Box) => void,
    occupied: Box[]
} => {
    const { nodes, cx, cy, boxW, boxH } = layout
    const occupied: Box[] = nodes.map((node) => [
        cx(node.id) - boxW.get(node.id)! / 2, cy(node.id) - boxH.get(node.id)! / 2,
        cx(node.id) + boxW.get(node.id)! / 2, cy(node.id) + boxH.get(node.id)! / 2
    ])

    /*  let the labels also dodge the group and container tags in the box corners  */
    for (const group of layout.groups ?? [])
        occupied.push([ group.x + TAG_DX, group.y + TAG_DY,
            group.x + TAG_DX + textWidth(group.name, FS_GROUP), group.y + TAG_DY + FS_GROUP * 1.2 ])
    for (const c of layout.containers ?? [])
        occupied.push([ c.x + TAG_DX, c.y + TAG_DY,
            c.x + TAG_DX + textWidth(c.node.name, FS_GROUP), c.y + containerHead(c.node, config) ])

    /*  collect the edge line segments and the hops bulging above them,
        kept per edge, so a label can tell its own route from the foreign ones  */
    const lines: Box[][] = layout.polys.map((poly, i) => {
        const boxes: Box[] = []
        for (let k = 0; k < poly.length - 1; k++) {
            const [ a, b ] = [ poly[k], poly[k + 1] ]
            boxes.push([ Math.min(a[0], b[0]) - LINE_PAD, Math.min(a[1], b[1]) - LINE_PAD,
                Math.max(a[0], b[0]) + LINE_PAD, Math.max(a[1], b[1]) + LINE_PAD ])
            for (const hx of hops[i].get(k) ?? [])
                boxes.push([ hx - hopRadius, a[1] - hopRadius, hx + hopRadius, a[1] ])
        }
        return boxes
    })
    const lineCount = lines.reduce((n, boxes) => n + boxes.length, 0)

    /*  index the edge line boxes in a uniform grid of buckets, so a
        candidate box only visits the line boxes of the buckets it
        covers instead of all of them (a line box spanning several
        buckets is visited once only, as every visit stamps it)  */
    const owner = new Int32Array(lineCount)
    const flat: Box[] = []
    let [ gx0, gy0, gx1, gy1 ] = [ Infinity, Infinity, -Infinity, -Infinity ]
    lines.forEach((boxes, i) => {
        for (const o of boxes) {
            owner[flat.length] = i
            flat.push(o)
            gx0 = Math.min(gx0, o[0])
            gy0 = Math.min(gy0, o[1])
            gx1 = Math.max(gx1, o[2])
            gy1 = Math.max(gy1, o[3])
        }
    })
    const gw      = flat.length > 0 ? Math.floor((gx1 - gx0) / BUCKET) + 1 : 0
    const gh      = flat.length > 0 ? Math.floor((gy1 - gy0) / BUCKET) + 1 : 0
    const buckets = new Map<number, number[]>()
    flat.forEach((o, k) => {
        for (let by = Math.floor((o[1] - gy0) / BUCKET); by <= Math.floor((o[3] - gy0) / BUCKET); by++)
            for (let bx = Math.floor((o[0] - gx0) / BUCKET); bx <= Math.floor((o[2] - gx0) / BUCKET); bx++) {
                const bucket = buckets.get(by * gw + bx)
                if (bucket === undefined)
                    buckets.set(by * gw + bx, [ k ])
                else
                    bucket.push(k)
            }
    })
    const stamps = new Uint32Array(flat.length)
    let   stamp  = 0

    /*  claim the candidate box colliding with the fewest occupied
        areas and, among those, with the fewest edge lines (earlier
        candidates win ties, so the first collision-free one is taken),
        where the own edge lines count on touch only, as the label sits
        beside its own route by construction, while the foreign ones
        count already within a clearance, so a label hugging a foreign
        line loses against one staying with its own edge. A claim with
        "dodge" unset weighs the lines not at all, as its candidates are
        ordered by a proximity which matters more than a crossed line,
        which the halo of the label keeps readable anyway  */
    const hit = (o: Box, x1: number, y1: number, x2: number, y2: number): boolean =>
        x1 < o[2] && x2 > o[0] && y1 < o[3] && y2 > o[1]
    const collisions = (boxes: Box[], box: Box): number => {
        let n = 0
        for (const o of boxes)
            if (hit(o, box[0], box[1], box[2], box[3]))
                n++
        return n
    }

    /*  count the edge line boxes a candidate box crosses, but stop
        counting once the given limit is reached, as the candidate then
        cannot win anymore (the own lines are tested against the box
        itself, the foreign ones against the box grown by the clearance,
        which hence also bounds the buckets to visit)  */
    const crossings = (box: Box, edge: number, limit: number): number => {
        const [ x1, y1, x2, y2 ] = [ box[0] - LINE_GAP, box[1] - LINE_GAP, box[2] + LINE_GAP, box[3] + LINE_GAP ]
        const bx1 = Math.max(Math.floor((x1 - gx0) / BUCKET), 0)
        const by1 = Math.max(Math.floor((y1 - gy0) / BUCKET), 0)
        const bx2 = Math.min(Math.floor((x2 - gx0) / BUCKET), gw - 1)
        const by2 = Math.min(Math.floor((y2 - gy0) / BUCKET), gh - 1)
        let n = 0
        stamp++
        for (let by = by1; by <= by2; by++) {
            for (let bx = bx1; bx <= bx2; bx++) {
                const bucket = buckets.get(by * gw + bx)
                if (bucket === undefined)
                    continue
                for (const k of bucket) {
                    if (stamps[k] === stamp)
                        continue
                    stamps[k] = stamp
                    if (owner[k] === edge ?
                        hit(flat[k], box[0], box[1], box[2], box[3]) : hit(flat[k], x1, y1, x2, y2))
                        if (++n >= limit)
                            return n
                }
            }
        }
        return n
    }
    const reserved: Box[] = []
    const reserve = (box: Box) => {
        reserved.push(box)
    }

    /*  a claim counts the areas reserved for the labels still to come
        like the occupied ones, so an early label yields the position a
        later one depends upon wherever it has an alternative of its
        own, while the "own" reservation of the claiming label is
        released, as that is the very area it is about to take  */
    const claim = (candidates: Box[], edge: number, dodge = true, own?: Box): Box => {
        if (own !== undefined) {
            const k = reserved.indexOf(own)
            if (k >= 0)
                reserved.splice(k, 1)
        }
        let box    = candidates[0]
        let lowest = Infinity
        for (const c of candidates) {
            /*  a candidate whose collisions alone already reach the lowest
                score is skipped, as its line crossings, of which there are
                at most "lineCount", can never let it win anymore  */
            let score = (collisions(occupied, c) + collisions(reserved, c)) * (lineCount + 1)
            if (score >= lowest)
                continue
            if (dodge)
                score += crossings(c, edge, lowest - score)
            if (score < lowest) {
                box    = c
                lowest = score
            }
            if (score === 0)
                break
        }
        occupied.push(box)
        return box
    }
    return { claim, reserve, occupied }
}

/*  generate the SVG fragments for a single node box (a node with a
    "url" attribute becomes a hyperlink covering the whole box)  */
const renderNode = (node: Node, layout: Layout, style: NodeStyle, styler: Styler,
    config: Config): string[] => {
    const { cx, cy, boxW, boxH, contentH } = layout
    const w     = boxW.get(node.id)!
    const h     = boxH.get(node.id)!
    const x     = cx(node.id) - w / 2
    const y     = cy(node.id) - h / 2
    const lines = linesOfNode(node, config)
    const url   = urlOf(node)
    const parts: string[] = []
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ` +
        `class="${styler.box(style.fill, style.stroke, 4)}"` +
        `${style.dash !== undefined ? ` stroke-dasharray="${escapeXML(style.dash)}"` : ""}/>`)

    /*  vertically center the textual content block within the box, with
        the optional type lines shifting the name and attributes down and
        the additional wrapped name lines shifting the attributes down  */
    const ty    = cy(node.id) - contentH.get(node.id)! / 2
    const th    = lines.type.length * TYPE_H(config)
    const nh    = (lines.name.length - 1) * NAME_H(config)
    const asc   = config["size-font-node"] * 0.36
    const nameY = lines.attrs.length > 0 ?
        ty + th + MIN_H(config) / 2 + asc : cy(node.id) + th / 2 + asc - nh / 2
    lines.type.forEach((line, k) => {
        parts.push(`<text x="${cx(node.id)}" ` +
            `y="${nameY - TYPE_D(config) - (lines.type.length - 1 - k) * TYPE_H(config)}" ` +
            `class="${styler.text(style.text, "size-font-type", { middle: true })}">${escapeXML(line)}</text>`)
    })
    lines.name.forEach((line, k) => {
        parts.push(`<text x="${cx(node.id)}" y="${nameY + k * NAME_H(config)}" ` +
            `class="${styler.text(style.text, "size-font-node", { bold: true, middle: true })}">` +
            `${escapeXML(line)}</text>`)
    })
    lines.attrs.forEach((line, k) => {
        parts.push(`<text x="${cx(node.id)}" ` +
            `y="${ty + th + nh + MIN_H(config) + ATTR_P + k * ATTR_H(config)}" ` +
            `class="${styler.text(style.text, "size-font-prop", { middle: true })}">${escapeXML(line)}</text>`)
    })
    if (url === undefined)
        return parts
    return [ `<a href="${escapeXML(url)}" xlink:href="${escapeXML(url)}">`, ...parts, "</a>" ]
}

/*  determine the overall bounding box of all rendered elements (the
    node boxes and the placed labels are handed over as already
    computed areas, the edge polylines are scanned here)  */
const viewBoxOf = (layout: Layout, boxes: Box[], margin: number): { x: number, y: number, w: number, h: number } => {
    const { polys } = layout
    let [ minX, minY, maxX, maxY ] = [ Infinity, Infinity, -Infinity, -Infinity ]
    for (const [ bx1, by1, bx2, by2 ] of boxes) {
        minX = Math.min(minX, bx1)
        minY = Math.min(minY, by1)
        maxX = Math.max(maxX, bx2)
        maxY = Math.max(maxY, by2)
    }
    for (const poly of polys) {
        for (const [ px, py ] of poly) {
            minX = Math.min(minX, px)
            minY = Math.min(minY, py)
            maxX = Math.max(maxX, px)
            maxY = Math.max(maxY, py)
        }
    }
    if (!Number.isFinite(minX))
        [ minX, minY, maxX, maxY ] = [ 0, 0, 0, 0 ]
    return {
        x: Math.floor(minX - margin / 2),
        y: Math.floor(minY - margin / 2),
        w: Math.ceil(maxX - minX + margin),
        h: Math.ceil(maxY - minY + margin)
    }
}

/*  the candidate positions of the arity label of an edge: set back
    from the arrow head along the final segment and placed beside the
    line, so an edge approaching vertically keeps its arity next to its
    own arrow, offering both sides at every further setback, which steps
    by the label extent along the segment, as a shorter step would leave
    the label on top of the very label it dodges  */
const arityBoxes = (arity: string, poly: Poly, config: Config): Box[] => {
    const w    = textWidth(arity, config["size-font-arity"])
    const h    = arityHeight(config)
    const p    = pointAt(poly, 1.0)
    const prev = pointAt(poly, 0.999)
    const candidates: Box[] = []
    for (let k = 0; k < ARITY_BACK; k++) {
        const back = k * ((p.horizontal ? w : h) + ARITY_STEP)
        if (p.horizontal) {
            const dx = Math.sign(p.x - prev.x) || 1
            const ax = p.x - dx * (ARITY_OFF + w / 2 + back)
            candidates.push([ ax - w / 2, p.y - ARITY_PAD - h, ax + w / 2, p.y - ARITY_PAD     ])
            candidates.push([ ax - w / 2, p.y + ARITY_PAD,     ax + w / 2, p.y + ARITY_PAD + h ])
        }
        else {
            const dy = Math.sign(p.y - prev.y) || 1
            const ay = p.y - dy * (ARITY_OFF + back)
            candidates.push([ p.x + 6,     ay + 6 - h, p.x + 6 + w, ay + 6 ])
            candidates.push([ p.x - 6 - w, ay + 6 - h, p.x - 6,     ay + 6 ])
        }
    }
    return candidates
}

/*  generate the SVG fragment for the arity label of a single edge,
    which claims one of its candidate positions without dodging the
    edge lines, as the neighboring ports of a node run closer than any
    clearance anyway and it is the very setback from its own arrow head
    which attaches it to its edge, so a line crossed beneath its halo
    weighs less than a drift away from that arrow  */
const renderEdgeArity = (edge: Edge, candidates: Box[], claim: (candidates: Box[], dodge?: boolean,
    own?: Box) => Box, styler: Styler): string[] => {
    if (edge.arity === undefined)
        return []
    const box = claim(candidates, false, candidates[0])
    return [ `<text x="${(box[0] + box[2]) / 2}" y="${box[3] - 3}" ` +
        `class="${styler.text("color-edge-arity", "size-font-arity", { middle: true, halo: true })}">` +
        `${escapeXML(edge.arity)}</text>` ]
}

/*  generate the SVG fragment for the name label of a single edge,
    placed near the middle of the route (dodging into a collision-free
    position through the "claim" of the label placer)  */
const renderEdgeName = (edge: Edge, poly: Poly, claim: (candidates: Box[], dodge?: boolean) => Box,
    styler: Styler, config: Config): string[] => {
    if (edge.name === undefined)
        return []
    const w = textWidth(edge.name, config["size-font-edge"])
    const h = config["size-font-edge"] + 4

    /*  offer, along every segment of the own route and on both sides
        of its line, the label centered on the segment plus the two
        positions flush with its ends plus, where the segment takes the
        label at all, the positions sliding between those ends in steps
        of half the label extent, as the free space along a route is
        regularly not where the segment centers are, and order the
        candidates by the distance from the middle of the route, so the
        label ends up as close to that middle as the collisions along
        the way allow  */
    const slide = (lo: number, hi: number, extent: number): number[] => {
        const first     = lo + extent / 2
        const last      = hi - extent / 2
        const positions = [ (lo + hi) / 2, first, last ]
        if (last > first) {
            const steps = Math.min(Math.ceil((last - first) / (extent / 2)), SLIDE_MAX)
            for (let k = 1; k < steps; k++)
                positions.push(first + (last - first) * k / steps)
        }
        return positions
    }
    const mid = pointAt(poly, 0.50)
    const near = (box: Box): number =>
        Math.abs((box[0] + box[2]) / 2 - mid.x) + Math.abs((box[1] + box[3]) / 2 - mid.y)
    const candidates: Box[] = []
    for (let k = 0; k < poly.length - 1; k++) {
        const [ a, b ] = [ poly[k], poly[k + 1] ]
        if (a[1] === b[1]) {
            for (const x of slide(Math.min(a[0], b[0]), Math.max(a[0], b[0]), w)) {
                candidates.push([ x - w / 2, a[1] - 3 - h, x + w / 2, a[1] - 3     ])
                candidates.push([ x - w / 2, a[1] + 3,     x + w / 2, a[1] + 3 + h ])
            }
        }
        else {
            for (const y of slide(Math.min(a[1], b[1]), Math.max(a[1], b[1]), h)) {
                candidates.push([ a[0] + 5,     y - h / 2, a[0] + 5 + w, y + h / 2 ])
                candidates.push([ a[0] - 5 - w, y - h / 2, a[0] - 5,     y + h / 2 ])
            }
        }
    }
    candidates.sort((a, b) => near(a) - near(b))
    const box = claim(candidates)
    return [ `<text x="${(box[0] + box[2]) / 2}" y="${box[3] - 3}" ` +
        `class="${styler.text("color-edge-name", "size-font-edge", { middle: true, halo: true })}">` +
        `${escapeXML(edge.name)}</text>` ]
}

/*  generate the SVG fragments for a single group box and its tag
    in the top-left corner  */
const renderGroup = (group: GroupBox, styler: Styler): string[] => [
    `<rect x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" rx="12" ` +
        `class="${styler.box("color-group-box", "color-group-border", 3)}"/>`,
    `<text x="${group.x + TAG_DX}" y="${group.y + TAG_DY + FS_GROUP}" ` +
        `class="${styler.text("color-group-name", FS_GROUP, { bold: true })}">${escapeXML(group.name)}</text>`
]

/*  generate the SVG fragments for a single container box and its tag
    in the top-left corner, with the optional type line above the name
    (a container with a "url" attribute becomes a hyperlink covering
    the whole box)  */
const renderContainer = (c: ContainerBox, styler: Styler, config: Config): string[] => {
    const type  = typeOf(c.node)
    const url   = urlOf(c.node)
    const parts = [
        `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="12" ` +
            `class="${styler.box("color-container-box", "color-container-border", 3)}" ` +
            "stroke-dasharray=\"10 6\"/>",
        ...(type !== undefined ? [
            `<text x="${c.x + TAG_DX}" y="${c.y + TAG_DY + config["size-font-type"]}" ` +
                `class="${styler.text("color-container-name", "size-font-type")}">${escapeXML(type)}</text>`
        ] : []),
        `<text x="${c.x + TAG_DX}" y="${c.y + containerHead(c.node, config) - HEAD_H + TAG_DY + FS_GROUP}" ` +
            `class="${styler.text("color-container-name", FS_GROUP, { bold: true })}">` +
            `${escapeXML(c.node.name)}</text>`
    ]
    if (url === undefined)
        return parts
    return [ `<a href="${escapeXML(url)}" xlink:href="${escapeXML(url)}">`, ...parts, "</a>" ]
}

/*  render a laid out graph into an SVG document (the seed determines the
    identifier prefix of the document, see "idPrefix" above)  */
export const renderSVG = (layout: Layout, config: Config, explicit: Partial<Config>,
    seed: string): string => {
    const { nodes, edges, polys } = layout
    const groups     = layout.groups     ?? []
    const containers = layout.containers ?? []
    const styleOf    = layout.styleOf    ?? defaultStyleOf

    /*  resolve the directly embedded configuration options into CSS
        values: explicitly configured values are hard-coded, while all
        others are fetched at display time from the "--gradia-<option>"
        CSS custom properties, falling back to the built-in defaults  */
    const color = (key: ConfigEmbedded): string => cssValueOf(explicit, key)

    /*  derive the collision-free identifiers of this SVG document  */
    const prefix  = idPrefix(seed)
    const idArrow = `${prefix}-arrow`

    /*  resolve the configured font into the rendered font family stack  */
    const { family, embed, weight } = resolveFont(config)
    const stack = Object.hasOwn(explicit, "font-family") ?
        `'${escapeCSS(family)}'` :
        `var(--gradia-font-family, '${escapeCSS(family)}')`
    const font = `${stack}, ui-sans-serif, -apple-system, Helvetica, Arial, sans-serif`

    /*  collect the CSS classes the rendered elements reference (the
        halo behind an edge label keeps it readable on top of a line)  */
    const rules = new Map<string, string>()
    const classOf = (decls: string): string => {
        let name = rules.get(decls)
        if (name === undefined) {
            name = `gradia-${new UUID(5, NS_GRADIA, decls).format("b16").toLowerCase().slice(0, 8)}`
            rules.set(decls, name)
        }
        return name
    }
    const styler: Styler = {
        text: (fill, size, options = {}) => classOf(
            `font-family: ${font}; ` +
            `font-size: ${typeof size === "number" ? `${size}px` : cssSizeOf(config, size)}; ` +
            (options.bold   ? "font-weight: 600; "    : "") +
            (options.middle ? "text-anchor: middle; " : "") +
            `fill: ${color(fill)}` +
            (options.halo ? `; stroke: ${color("color-edge-halo")}; stroke-width: 4.5; ` +
                "paint-order: stroke; stroke-linejoin: round" : "")),
        box: (fill, stroke, width) => classOf(
            `fill: ${color(fill)}; stroke: ${color(stroke)}; stroke-width: ${width}`)
    }
    const classEdge  = classOf(`fill: none; stroke: ${color("color-edge-line")}; stroke-width: 3`)
    const classArrow = classOf(`fill: ${color("color-edge-line")}`)

    /*  detect the edge crossings requiring rendered hops  */
    const hops = computeHops(polys)

    /*  prepare the collision-free placement of the edge labels  */
    const { claim, reserve, occupied } = labelPlacer(layout, hops, config["size-edge-hop-radius"], config)

    /*  generate the SVG fragments for the edge paths  */
    const svgEdges = polys.map((poly, i) =>
        `<path d="${pathOf(poly, hops[i],
            config["size-edge-corner-radius"], config["size-edge-hop-radius"])}" ` +
        `class="${classEdge}" marker-end="url(#${idArrow})"/>`)

    /*  reserve the position every arity label prefers -- the one beside
        its own arrow head -- before any name label is placed, as an
        arity is bound to that arrow while a name may slide along the
        whole route: a name hence yields the reserved area wherever it
        has an alternative, and only a name left without one takes it
        and pushes its arity onto the next setback  */
    const arities = edges.map((edge, i) =>
        edge.arity !== undefined ? arityBoxes(edge.arity, polys[i], config) : undefined)
    for (const candidates of arities)
        if (candidates !== undefined)
            reserve(candidates[0])

    /*  generate the SVG fragments for the edge labels (the names
        first, as their reservations keep the arity positions free)  */
    const svgLabels: string[] = []
    edges.forEach((edge, i) => {
        svgLabels.push(...renderEdgeName(edge, polys[i], (c, dodge) => claim(c, i, dodge), styler, config))
    })
    edges.forEach((edge, i) => {
        const candidates = arities[i]
        if (candidates !== undefined)
            svgLabels.push(...renderEdgeArity(edge, candidates,
                (c, dodge, own) => claim(c, i, dodge, own), styler))
    })

    /*  generate the SVG fragments for the node boxes  */
    const svgNodes = nodes.flatMap((node) => renderNode(node, layout, styleOf(node), styler, config))

    /*  generate the SVG fragments for the group boxes (drawn below
        everything else) and the container boxes (drawn below the edges
        and nodes, an outer box before its nested ones)  */
    const svgGroups     = groups.flatMap((group) => renderGroup(group, styler))
    const svgContainers = containers.flatMap((c) => renderContainer(c, styler, config))

    /*  determine the overall bounding box of all rendered elements  */
    const groupBoxes: Box[] = groups.map((group) =>
        [ group.x, group.y, group.x + group.w, group.y + group.h ])
    const containerBoxes: Box[] = containers.map((c) =>
        [ c.x, c.y, c.x + c.w, c.y + c.h ])
    const vb = viewBoxOf(layout, [ ...occupied, ...groupBoxes, ...containerBoxes ], config["size-canvas-margin"])

    /*  assemble the final SVG document (with one CSS rule per line)  */
    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" " +
            `viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${vb.w}" height="${vb.h}">`,
        "<defs>",
        "<style>",
        ...(embed !== undefined ? [
            `@font-face { font-family: "${escapeXML(escapeCSS(family))}"; ` +
                (weight !== undefined ? `font-weight: ${escapeXML(escapeCSS(weight))}; ` : "") +
                `src: url(data:font/woff2;base64,${embed}) format("woff2"); }`
        ] : []),
        ...Array.from(rules, ([ decls, name ]) => `.${name} { ${escapeXML(decls)} }`),
        "</style>",
        `<marker id="${idArrow}" viewBox="0 0 10 10" refX="9" refY="5" ` +
            "markerWidth=\"21\" markerHeight=\"21\" markerUnits=\"userSpaceOnUse\" " +
            "orient=\"auto-start-reverse\">",
        `<path d="M 0 1 L 9 5 L 0 9 z" class="${classArrow}"/>`,
        "</marker>",
        "</defs>",
        ...svgGroups,
        ...svgContainers,
        ...svgEdges,
        ...svgNodes,
        ...svgLabels,
        "</svg>",
        ""
    ].join("\n")
}

