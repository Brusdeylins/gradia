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
    FS_GROUP, ARITY_OFF, ARITY_PAD, ARITY_GAP, ARROW_AIR, arityHeight, textWidth, escapeXML }
    from "./gradia-api-render-base.js"
import { Shape }                                            from "./gradia-api-render-shape.js"
import { linesOfNode, urlOf, typeOf, defaultStyleOf, containerHead, shapeOf, badgeExtent,
    QUEUE_RX, STACK_OFF, BADGE_R, type NodeShape, MIN_H, NAME_H, ATTR_H, ATTR_P, TYPE_H, TYPE_D, HEAD_H }
    from "./gradia-api-render-node.js"
import { computeHops, piecesOf, pathOf, pointAt, segmentsOf, junctionsOf }
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
        options?: { bold?: boolean, middle?: boolean, end?: boolean, halo?: boolean }) => string
    box:  (fill: ConfigEmbedded, stroke: ConfigEmbedded, width: number) => string
    line: (stroke: ConfigEmbedded, width: number) => string
}

/*  a rectangular area, given by its top-left and bottom-right corners  */
type Box = [ number, number, number, number ]

/*  the placement of a group tag in the top-left corner of its group box  */
const TAG_DX = 18  /*  left offset of the group tag  */
const TAG_DY = 12  /*  top offset of the group tag   */

/*  the half width of the box an edge line segment occupies  */
const LINE_PAD = 2

/*  the radius of the dot marking a junction of bundled edges (clearly
    wider than an edge line, but far below an arrow head)  */
const JUNCTION_R = 5

/*  the gap a name label on the stub of a bundled edge keeps in front of
    the shared track, clear of its junction dot and foreign lines  */
const STUB_GAP = 16

/*  the clearance a label keeps from a foreign edge line, as a label
    merely not overlapping such a line still reads as its annotation  */
const LINE_GAP = 12

/*  the gap between two arity labels set back one behind the other along
    one and the same edge line, and the number of such setbacks tried  */
const ARITY_STEP = 8
const ARITY_BACK = 3

/*  the step by which the anchor of a name label is set back along the
    stub arriving at the target, and the air it keeps beside it  */
const ANCHOR_STEP = 8
const ANCHOR_AIR  = 6

/*  the maximum number of steps a name label is slid along a single
    segment of its route, as a long segment would otherwise offer far
    more candidate positions than a placement can ever need  */
const SLIDE_MAX = 16

/*  a uniform grid of buckets indexing areas, so a query only visits
    the areas of the buckets it covers instead of all areas (an area
    spanning several buckets is visited once only, as every visit
    stamps it, and the bucket indices are clamped, so even far-off
    areas stay indexed, merely sharing the outermost buckets)  */
const BUCKET    = 64
const GRID_OFF  = 1 << 20
const GRID_SPAN = 2 * GRID_OFF
interface AreaGrid {
    add:    (area: Box) => number
    remove: (id: number) => void
    visit:  (x1: number, y1: number, x2: number, y2: number, fn: (id: number, area: Box) => boolean) => void
}
const areaGrid = (): AreaGrid => {
    const areas:   (Box | undefined)[] = []
    const buckets = new Map<number, number[]>()
    let   stamps  = new Uint32Array(0)
    let   stamp   = 0
    const bucketOf = (v: number): number =>
        Math.max(-GRID_OFF, Math.min(GRID_OFF - 1, Math.floor(v / BUCKET)))

    /*  index an area and return its identifier  */
    const add = (area: Box): number => {
        const id = areas.length
        areas.push(area)
        for (let by = bucketOf(area[1]); by <= bucketOf(area[3]); by++) {
            for (let bx = bucketOf(area[0]); bx <= bucketOf(area[2]); bx++) {
                const bucket = buckets.get(bx * GRID_SPAN + by)
                if (bucket === undefined)
                    buckets.set(bx * GRID_SPAN + by, [ id ])
                else
                    bucket.push(id)
            }
        }
        return id
    }

    /*  drop an indexed area  */
    const remove = (id: number): void => {
        areas[id] = undefined
    }

    /*  visit every indexed area sharing a bucket with the queried area
        once, until the visiting function signals to stop  */
    const visit = (x1: number, y1: number, x2: number, y2: number,
        fn: (id: number, area: Box) => boolean): void => {
        if (stamps.length < areas.length) {
            const grown = new Uint32Array(Math.max(areas.length, 2 * stamps.length))
            grown.set(stamps)
            stamps = grown
        }
        stamp++
        for (let by = bucketOf(y1); by <= bucketOf(y2); by++) {
            for (let bx = bucketOf(x1); bx <= bucketOf(x2); bx++) {
                const bucket = buckets.get(bx * GRID_SPAN + by)
                if (bucket === undefined)
                    continue
                for (const id of bucket) {
                    if (stamps[id] === stamp)
                        continue
                    stamps[id] = stamp
                    const area = areas[id]
                    if (area !== undefined && fn(id, area))
                        return
                }
            }
        }
    }
    return { add, remove, visit }
}

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
    claim:    (candidates: Box[], edge: number, dodge?: boolean, own?: Box, mates?: number[]) => Box,
    seize:    (box: Box, edge: number) => boolean,
    reserve:  (box: Box) => void,
    occupied: Box[]
} => {
    const { nodes, cx, cy, boxW, boxH } = layout
    const occupied: Box[] = nodes.map((node) => [
        cx(node.id) - boxW.get(node.id)! / 2,
        cy(node.id) - boxH.get(node.id)! / 2 - badgeExtent(node),
        cx(node.id) + boxW.get(node.id)! / 2, cy(node.id) + boxH.get(node.id)! / 2
    ])

    /*  let the labels also dodge the group and container tags in the box corners  */
    for (const group of layout.groups ?? [])
        occupied.push([ group.x + TAG_DX, group.y + TAG_DY,
            group.x + TAG_DX + textWidth(group.name, FS_GROUP), group.y + TAG_DY + FS_GROUP * 1.2 ])
    for (const c of layout.containers ?? [])
        occupied.push([ c.x + TAG_DX, c.y + TAG_DY,
            c.x + TAG_DX + textWidth(c.node.name, FS_GROUP), c.y + containerHead(c.node, config) ])

    /*  let the labels also dodge the free-standing texts  */
    for (const shape of layout.shapes ?? [])
        if (shape.kind === "text")
            occupied.push(shape.box)

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

    /*  index the edge line boxes, the occupied areas, and the
        reserved areas, as the placement of every label queries them
        for all of its candidate boxes  */
    const lineGrid = areaGrid()
    const owner: number[] = []
    lines.forEach((boxes, i) => {
        for (const o of boxes)
            owner[lineGrid.add(o)] = i
    })
    const occupiedGrid = areaGrid()
    for (const o of occupied)
        occupiedGrid.add(o)
    const reservedGrid = areaGrid()

    /*  claim the candidate box colliding with the fewest occupied
        areas and, among those, with the fewest edge lines (earlier
        candidates win ties, so the first collision-free one is taken),
        where the own edge lines count on touch only, as the label sits
        beside its own route by construction, while the foreign ones
        count already within a clearance, so a label hugging a foreign
        line loses against one staying with its own edge. A claim with
        "dodge" unset weighs the lines not at all, as its candidates are
        ordered by a proximity which matters more than a crossed line,
        which the halo of the label keeps readable anyway (the lines of
        the "mates" of the edge, labeled together with it, count as own)  */
    const hit = (o: Box, x1: number, y1: number, x2: number, y2: number): boolean =>
        x1 < o[2] && x2 > o[0] && y1 < o[3] && y2 > o[1]
    const collisions = (grid: AreaGrid, box: Box): number => {
        let n = 0
        grid.visit(box[0], box[1], box[2], box[3], (_, o) => {
            if (hit(o, box[0], box[1], box[2], box[3]))
                n++
            return false
        })
        return n
    }

    /*  count the edge line boxes a candidate box crosses, but stop
        counting once the given limit is reached, as the candidate then
        cannot win anymore (the own lines are tested against the box
        itself, the foreign ones against the box grown by the clearance,
        which hence also bounds the buckets to visit)  */
    const crossings = (box: Box, edge: number, limit: number, mates?: number[], gap = LINE_GAP): number => {
        const [ x1, y1, x2, y2 ] = [ box[0] - gap, box[1] - gap, box[2] + gap, box[3] + gap ]
        let n = 0
        lineGrid.visit(x1, y1, x2, y2, (id, o) => {
            if (owner[id] === edge || mates?.includes(owner[id]) === true ?
                hit(o, box[0], box[1], box[2], box[3]) : hit(o, x1, y1, x2, y2))
                n++
            return n >= limit
        })
        return n
    }

    /*  reserve an area, indexed under its very object, so the claim of
        the label it is reserved for can release it again  */
    const reserved = new Map<Box, number[]>()
    const reserve = (box: Box) => {
        const id  = reservedGrid.add(box)
        const ids = reserved.get(box)
        if (ids === undefined)
            reserved.set(box, [ id ])
        else
            ids.push(id)
    }

    /*  a claim counts the areas reserved for the labels still to come
        like the occupied ones, so an early label yields the position a
        later one depends upon wherever it has an alternative of its
        own, while the "own" reservation of the claiming label is
        released, as that is the very area it is about to take  */
    const claim = (candidates: Box[], edge: number, dodge = true, own?: Box, mates?: number[]): Box => {
        if (own !== undefined) {
            const id = reserved.get(own)?.shift()
            if (id !== undefined)
                reservedGrid.remove(id)
        }
        let box    = candidates[0]
        let lowest = Infinity
        for (const c of candidates) {
            /*  a candidate whose collisions alone already reach the lowest
                score is skipped, as its line crossings, of which there are
                at most "lineCount", can never let it win anymore  */
            let score = (collisions(occupiedGrid, c) + collisions(reservedGrid, c)) * (lineCount + 1)
            if (score >= lowest)
                continue
            if (dodge)
                score += crossings(c, edge, lowest - score, mates)
            if (score < lowest) {
                box    = c
                lowest = score
            }
            if (score === 0)
                break
        }
        occupied.push(box)
        occupiedGrid.add(box)
        return box
    }

    /*  claim a single box only if it is free: colliding with no occupied
        or reserved area (with some air beside it) and crossed by no other
        line at all, as its fixed position attributes it to its edge  */
    const seize = (box: Box, edge: number): boolean => {
        const aired: Box = [ box[0] - ANCHOR_AIR, box[1], box[2] + ANCHOR_AIR, box[3] ]
        if (collisions(occupiedGrid, aired) > 0 || collisions(reservedGrid, aired) > 0
            || crossings(box, edge, 1, undefined, 0) > 0)
            return false
        occupied.push(box)
        occupiedGrid.add(box)
        return true
    }
    return { claim, seize, reserve, occupied }
}

/*  generate the SVG fragments of the outline of a node box of a shape,
    fitting the box of the regular shape (except a badge on its top
    border), so the edges still start and end at the outline (a badge
    glyph taking the text color, as the border color is too faint)  */
const renderOutline = (shape: NodeShape, x: number, y: number, w: number, h: number,
    style: NodeStyle, styler: Styler): string[] => {
    const cls  = styler.box(style.fill, style.stroke, 4)
    const dash = style.dash !== undefined ? ` stroke-dasharray="${escapeXML(style.dash)}"` : ""
    if (shape === "database") {
        const ry = Math.min(16, h / 7)
        return [ `<path d="M ${x} ${y + ry} a ${w / 2} ${ry} 0 0 1 ${w} 0 v ${h - 2 * ry} ` +
                `a ${w / 2} ${ry} 0 0 1 ${-w} 0 z" class="${cls}"${dash}/>`,
        `<path d="M ${x} ${y + ry} a ${w / 2} ${ry} 0 0 0 ${w} 0" class="${cls}"${dash}/>` ]
    }
    else if (shape === "queue") {
        const rx = QUEUE_RX
        return [ `<path d="M ${x + rx} ${y} h ${w - 2 * rx} a ${rx} ${h / 2} 0 0 1 0 ${h} ` +
                `h ${2 * rx - w} a ${rx} ${h / 2} 0 0 1 0 ${-h} z" class="${cls}"${dash}/>`,
        `<path d="M ${x + w - rx} ${y} a ${rx} ${h / 2} 0 0 0 0 ${h}" class="${cls}"${dash}/>` ]
    }
    else if (shape === "cloud") {
        /*  bulges all around: arcs between points on an ellipse, which
            touches the left and right box border at half height (where
            the edges attach), with the bulges of the top and bottom
            staying inside the box  */
        const n  = 12
        const [ cx, cy ] = [ x + w / 2, y + h / 2 ]
        const [ a, b ]   = [ w / 2, h / 2 - h * 0.14 ]
        const pt = (k: number) => {
            const t = Math.PI * 2 * k / n - Math.PI / 2
            return [ cx + a * Math.cos(t), cy + b * Math.sin(t) ]
        }
        const [ sx, sy ] = pt(0)
        let d = `M ${sx} ${sy}`
        for (let k = 1; k <= n; k++) {
            const [ px, py ] = pt(k - 1)
            const [ qx, qy ] = pt(k)
            const r = Math.hypot(qx - px, qy - py) * 0.58
            d += ` A ${r} ${r} 0 0 1 ${qx} ${qy}`
        }
        return [ `<path d="${d} z" class="${cls}"${dash}/>` ]
    }
    else if (shape === "stack")
        return [ STACK_OFF, STACK_OFF / 2, 0 ].map((d) =>
            `<rect x="${x + d}" y="${y + STACK_OFF - d}" width="${w - STACK_OFF}" height="${h - STACK_OFF}" rx="6" ` +
            `class="${cls}"${dash}/>`)
    const box = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" class="${cls}"${dash}/>`
    if (shape === "person" || shape === "device") {
        const [ bx, by, r ] = [ x + w / 2, y, BADGE_R ]
        const glyph = shape === "person" ?
            `M ${bx} ${by - 7} m -3.5 0 a 3.5 3.5 0 1 0 7 0 a 3.5 3.5 0 1 0 -7 0 ` +
                `M ${bx - 7} ${by + 8} q 0 -8 7 -8 q 7 0 7 8` :
            `M ${bx - 7} ${by - 7} h 14 v 10 h -14 z M ${bx - 4} ${by + 7} h 8 M ${bx} ${by + 3} v 4`
        return [ box, `<circle cx="${bx}" cy="${by}" r="${r}" class="${cls}"${dash}/>`,
            `<path d="${glyph}" class="${styler.line(style.text, 2.5)}"/>` ]
    }
    return [ box ]
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
    const shape = shapeOf(node)

    /*  the text sits centered on the body of the outline: left of the
        inner cap of a lying cylinder, and on the front box of a stack  */
    const tx    = cx(node.id) - (shape === "queue" ? QUEUE_RX / 2 : shape === "stack" ? STACK_OFF / 2 : 0)
    const ty0   = shape === "stack" ? STACK_OFF / 2 : 0
    const url   = urlOf(node)
    const parts = renderOutline(shape, x, y, w, h, style, styler)

    /*  vertically center the textual content block within the box, with
        the optional type lines shifting the name and attributes down and
        the additional wrapped name lines shifting the attributes down  */
    const ty    = cy(node.id) + ty0 - contentH.get(node.id)! / 2
    const th    = lines.type.length * TYPE_H(config)
    const nh    = (lines.name.length - 1) * NAME_H(config)
    const asc   = config["size-font-node"] * 0.36
    const nameY = lines.attrs.length > 0 ?
        ty + th + MIN_H(config) / 2 + asc : cy(node.id) + ty0 + th / 2 + asc - nh / 2
    lines.type.forEach((line, k) => {
        parts.push(`<text x="${tx}" ` +
            `y="${nameY - TYPE_D(config) - (lines.type.length - 1 - k) * TYPE_H(config)}" ` +
            `class="${styler.text(style.text, "size-font-type", { middle: true })}">${escapeXML(line)}</text>`)
    })
    lines.name.forEach((line, k) => {
        parts.push(`<text x="${tx}" y="${nameY + k * NAME_H(config)}" ` +
            `class="${styler.text(style.text, "size-font-node", { bold: true, middle: true })}">` +
            `${escapeXML(line)}</text>`)
    })
    lines.attrs.forEach((line, k) => {
        parts.push(`<text x="${tx}" ` +
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

/*  the preferred positions of the name labels of the bundled edges: on
    the stub feeding the shared track (or else leaving it), flush toward
    the track, above (or else below) the line, so the labels of a bundle
    line up in front of the track instead of scattering along the stubs  */
const stubLabels = (layout: Layout, config: Config): Map<number, Box[]> => {
    const { edges, polys } = layout
    const anchors = new Map<number, Box[]>()
    const bundled = (i: number): boolean => layout.bundled?.[i] === true
    if (!edges.some((edge, i) => bundled(i) && edge.name !== undefined))
        return anchors

    /*  a vertical segment lies on a shared track if another bundled edge
        runs on its X position, and a horizontal stub is an own one if
        no other bundled edge overlaps it  */
    const { verts, horzs } = segmentsOf(polys, bundled)
    const shared = (i: number, a: [ number, number ], b: [ number, number ]): boolean =>
        a[0] === b[0] && (verts.get(a[0]) ?? []).some((seg) => seg.owner !== i)
    const own = (i: number, a: [ number, number ], b: [ number, number ]): boolean =>
        !(horzs.get(a[1]) ?? []).some((seg) => seg.owner !== i
            && Math.min(seg.hi, Math.max(a[0], b[0])) > Math.max(seg.lo, Math.min(a[0], b[0])))

    /*  place the label of every bundled edge on its first horizontal
        stub turning onto (or else coming from) a shared track, as far
        as the stub is long enough to hold it  */
    edges.forEach((edge, i) => {
        if (!bundled(i) || edge.name === undefined)
            return
        const poly = polys[i]
        const w    = textWidth(edge.name, config["size-font-edge"])
        const h    = config["size-font-edge"] + 4
        for (const feeding of [ true, false ]) {
            for (let k = 0; k < poly.length - 1; k++) {
                const [ a, b ] = [ poly[k], poly[k + 1] ]
                if (a[1] !== b[1] || !own(i, a, b) || !(feeding ?
                    k + 2 < poly.length && shared(i, b, poly[k + 2]) :
                    k >= 1 && shared(i, poly[k - 1], a)))
                    continue
                const [ from, at ] = feeding ? [ a, b ] : [ b, a ]
                if (Math.abs(at[0] - from[0]) < w + 2 * STUB_GAP)
                    continue
                const dir = Math.sign(at[0] - from[0])
                const x2  = at[0] - dir * STUB_GAP
                const x1  = x2 - dir * w
                anchors.set(i, [
                    [ Math.min(x1, x2), a[1] - 3 - h, Math.max(x1, x2), a[1] - 3     ],
                    [ Math.min(x1, x2), a[1] + 3,     Math.max(x1, x2), a[1] + 3 + h ]
                ])
                return
            }
        }
    })
    return anchors
}

/*  the anchors of the name label of an edge: on the last horizontal
    segment of its route, above the line on the baseline of the arity,
    flush in front of the arity (or its setback from the arrow head) or,
    for a route ending in a vertical run, in front of the corner into
    that run, and, where that spot is taken, stepping back along the
    segment as far as the label stays clear of its other corner  */
const arrivalLabels = (edge: Edge, poly: Poly, config: Config): Box[] => {
    if (edge.name === undefined)
        return []
    let k = poly.length - 2
    while (k >= 0 && poly[k][1] !== poly[k + 1][1])
        k--
    if (k < 0)
        return []
    const [ a, b ] = [ poly[k], poly[k + 1] ]
    const w      = textWidth(edge.name, config["size-font-edge"])
    const h      = config["size-font-edge"] + 4
    const radius = config["size-edge-corner-radius"]
    const gap    = k === poly.length - 2 ? ARITY_OFF +
        (edge.arity !== undefined ? textWidth(edge.arity, config["size-font-arity"]) + ARITY_GAP : 0) :
        radius + ARROW_AIR
    const dir    = Math.sign(b[0] - a[0])
    const room   = Math.abs(b[0] - a[0]) - gap - w - (k > 0 ? radius : 0)
    const anchors: Box[] = []
    for (let back = 0; back <= room; back += ANCHOR_STEP) {
        const x2 = b[0] - dir * (gap + back)
        const x1 = x2 - dir * w
        anchors.push([ Math.min(x1, x2), b[1] - ARITY_PAD - h, Math.max(x1, x2), b[1] - ARITY_PAD ])
    }
    return anchors
}

/*  the preferred positions of the one name label of a group of bundled
    edges merged into one port, on the stub between their track and that
    port, above the line: at the anchor of a single edge (see
    "arrivalLabels") at the port they run into, and flush with the box
    (or else below the line) at the one they leave  */
const portLabels = (edge: Edge, poly: Poly, into: boolean, config: Config): Box[] => {
    if (edge.name === undefined)
        return []
    if (into)
        return poly[poly.length - 2][1] === poly[poly.length - 1][1] ? arrivalLabels(edge, poly, config).slice(0, 1) : []
    const w = textWidth(edge.name, config["size-font-edge"])
    const h = config["size-font-edge"] + 4
    const [ a, b ] = [ poly[1], poly[0] ]
    if (a[1] !== b[1])
        return []
    const dir   = Math.sign(b[0] - a[0])
    const span  = (x2: number): [ number, number ] =>
        [ Math.min(x2, x2 - dir * w), Math.max(x2, x2 - dir * w) ]
    const below = (x2: number): Box => [ span(x2)[0], b[1] + 3, span(x2)[1], b[1] + 3 + h ]
    const above = (x2: number): Box => [ span(x2)[0], b[1] - 3 - h, span(x2)[1], b[1] - 3 ]
    return [ above(b[0] - dir * STUB_GAP), below(b[0] - dir * STUB_GAP) ]
}

/*  generate the SVG fragment for the name label of a single edge,
    placed near the middle of the route (dodging into a collision-free
    position through the "claim" of the label placer), or, for a
    bundled edge, preferably at one of its given stub positions  */
const renderEdgeName = (edge: Edge, poly: Poly, claim: (candidates: Box[], dodge?: boolean) => Box,
    styler: Styler, config: Config, preferred: Box[] = []): string[] => {
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
    candidates.unshift(...preferred)
    return nameText(edge, claim(candidates), styler)
}

/*  generate the SVG fragment for the name label of an edge at its claimed
    position, centered on it, or else aligned to its start or end (as the
    estimated text width may deviate, and an anchored label stays flush)  */
const nameText = (edge: Edge, box: Box, styler: Styler,
    align: "middle" | "start" | "end" = "middle"): string[] =>
    [ `<text x="${align === "middle" ? (box[0] + box[2]) / 2 : align === "start" ? box[0] : box[2]}" ` +
        `y="${box[3] - 3}" class="${styler.text("color-edge-name",
            "size-font-edge", { middle: align === "middle", end: align === "end", halo: true })}">` +
        `${escapeXML(edge.name ?? "")}</text>` ]

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

/*  generate the SVG fragment for a single free-standing shape  */
const renderShape = (shape: Shape, styler: Styler): string => {
    if (shape.kind === "path")
        return `<path d="M ${shape.x} ${shape.y} ${shape.d}" class="${shape.fill !== undefined ?
            styler.box(shape.fill, shape.stroke, shape.width) : styler.line(shape.stroke, shape.width)}"` +
            `${shape.dash !== undefined ? ` stroke-dasharray="${escapeXML(shape.dash)}"` : ""}/>`
    const text = `<text x="${shape.x}" y="${shape.y}"${shape.anchor !== "start" ? ` text-anchor="${shape.anchor}"` : ""} ` +
        `class="${styler.text(shape.fill, shape.size, { bold: shape.bold, halo: shape.halo !== false })}">` +
        `${escapeXML(shape.text)}</text>`
    return shape.url === undefined ? text :
        `<a href="${escapeXML(shape.url)}" xlink:href="${escapeXML(shape.url)}">${text}</a>`
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
    const idOpen  = `${prefix}-arrow-open`

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
            (options.end    ? "text-anchor: end; "    : "") +
            `fill: ${color(fill)}` +
            (options.halo ? `; stroke: ${color("color-edge-halo")}; stroke-width: 4.5; ` +
                "paint-order: stroke; stroke-linejoin: round" : "")),
        box: (fill, stroke, width) => classOf(
            `fill: ${color(fill)}; stroke: ${color(stroke)}; stroke-width: ${width}`),
        line: (stroke, width) => classOf(
            `fill: none; stroke: ${color(stroke)}; stroke-width: ${width}; stroke-linecap: round; stroke-linejoin: round`)
    }
    const classEdge  = classOf(`fill: none; stroke: ${color("color-edge-line")}; stroke-width: 3`)
    const classArrow = classOf(`fill: ${color("color-edge-line")}`)

    /*  detect the edge crossings requiring rendered hops  */
    const hops = computeHops(polys)

    /*  prepare the collision-free placement of the edge labels  */
    const { claim, seize, reserve, occupied } = labelPlacer(layout, hops, config["size-edge-hop-radius"], config)

    /*  generate the SVG fragments for the edge paths (sharply turning
        at the junctions of bundled edges) and the dots marking those
        junctions on top of them, where only the first edge of a group
        merged into one port draws the arrow head and the arity there, and
        the segments shared by bundled edges are drawn once (see "piecesOf")  */
    const junctions  = junctionsOf(polys, (i) => layout.bundled?.[i] === true)
    const junctionAt = new Set(junctions.map(([ x, y ]) => `${x}:${y}`))
    const junction   = junctionAt.size > 0 ? (x: number, y: number) => junctionAt.has(`${x}:${y}`) : undefined
    const groupsAt = (end: (poly: Poly) => [ number, number ]): Map<number, number[]> => {
        const byPort = new Map<string, number[]>()
        polys.forEach((poly, i) => {
            if (layout.bundled?.[i] === true)
                byPort.set(`${end(poly)}`, [ ...byPort.get(`${end(poly)}`) ?? [], i ])
        })
        return new Map(Array.from(byPort.values()).filter((l) => l.length > 1).map((l) => [ l[0], l ]))
    }
    const into    = groupsAt((poly) => poly[poly.length - 1])
    const outOf   = groupsAt((poly) => poly[0])
    const grouped = new Set([ ...into.values(), ...outOf.values() ].flat())
    const repeat  = new Set(Array.from(into.values()).flatMap((l) => l.slice(1)))

    /*  a return or create edge is drawn dashed, and an asynchronous,
        return, or create edge ends in an open arrow head, an outlined
        triangle filled with the halo color, so it covers the line ending
        at its tip (its marker and classes are defined only on demand, so
        diagrams without such edges stay unchanged)  */
    const kindOf    = (i: number) => edges[i].kind ?? "sync"
    const dashed    = (i: number) => kindOf(i) === "return" || kindOf(i) === "create"
    const hollow    = (i: number) => dashed(i) || kindOf(i) === "async"
    const open      = polys.some((_, i) => hollow(i))
    const classOpen = open ? classOf(`fill: ${color("color-edge-halo")}; stroke: ${color("color-edge-line")}; ` +
        "stroke-width: 1.2; stroke-linejoin: round") : ""
    const classDash = polys.some((_, i) => dashed(i)) ?
        classOf(`fill: none; stroke: ${color("color-edge-line")}; stroke-width: 3; stroke-dasharray: 10 6`) : ""
    const svgEdges = piecesOf(polys, layout.bundled).flatMap((pieces, i) => pieces.map((piece) =>
        `<path d="${pathOf(polys[i], hops[i], config["size-edge-corner-radius"], config["size-edge-hop-radius"],
            junction, layout.crowded === true, piece)}" ` +
        `class="${dashed(i) ? classDash : classEdge}"` +
        (repeat.has(i) || !piece.end ? "/>" : ` marker-end="url(#${hollow(i) ? idOpen : idArrow})"/>`)))
    const svgJunctions = junctions.map(([ x, y ]) =>
        `<circle cx="${x}" cy="${y}" r="${JUNCTION_R}" class="${classArrow}"/>`)

    /*  reserve the position every arity label prefers -- the one beside
        its own arrow head -- before any name label is placed, as an
        arity is bound to that arrow while a name may slide along the
        whole route: a name hence yields the reserved area wherever it
        has an alternative, and only a name left without one takes it
        and pushes its arity onto the next setback  */
    const arities = edges.map((edge, i) =>
        edge.arity !== undefined && !repeat.has(i) ? arityBoxes(edge.arity, polys[i], config) : undefined)
    for (const candidates of arities)
        if (candidates !== undefined)
            reserve(candidates[0])

    /*  generate the SVG fragments for the edge labels (the names
        first, as their reservations keep the arity positions free),
        where every unbundled name first takes its anchor (see
        "arrivalLabels"), before any name searches a position of its own,
        and only a name without a free anchor searches along its route  */
    const svgLabels: string[] = []
    const stubAt = stubLabels(layout, config)
    const placed = edges.map((edge, i) => {
        if (layout.bundled?.[i] === true || layout.centered === true)
            return false
        const anchor = arrivalLabels(edge, polys[i], config).find((box) => seize(box, i))
        if (anchor === undefined)
            return false
        svgLabels.push(...nameText(edge, anchor, styler,
            anchor[2] <= polys[i][polys[i].length - 1][0] ? "end" : "start"))
        return true
    })
    edges.forEach((edge, i) => {
        if (placed[i])
            return
        const name = (preferred?: Box[], mates?: number[]) =>
            svgLabels.push(...renderEdgeName(edge, polys[i],
                (c, dodge) => claim(c, i, dodge, undefined, mates),
                styler, config, preferred))
        if (!grouped.has(i))
            name(stubAt.get(i))
        if (into.has(i))
            name(portLabels(edge, polys[i], true, config), into.get(i))
        if (outOf.has(i))
            name(portLabels(edge, polys[i], false, config), outOf.get(i))
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

    /*  generate the SVG fragments for the free-standing shapes (drawn
        above the boxes and below the edges and nodes, in their order,
        except the texts, drawn above the nodes like the edge labels)  */
    const shapes    = layout.shapes ?? []
    const svgShapes = shapes.filter((shape) => shape.kind !== "text").map((shape) => renderShape(shape, styler))
    const svgTexts  = shapes.filter((shape) => shape.kind === "text").map((shape) => renderShape(shape, styler))

    /*  determine the overall bounding box of all rendered elements  */
    const groupBoxes: Box[] = groups.map((group) =>
        [ group.x, group.y, group.x + group.w, group.y + group.h ])
    const containerBoxes: Box[] = containers.map((c) =>
        [ c.x, c.y, c.x + c.w, c.y + c.h ])
    const vb = viewBoxOf(layout, [ ...occupied, ...groupBoxes, ...containerBoxes, ...shapes.map((shape) => shape.box) ],
        config["size-canvas-margin"])

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
        ...(open ? [
            `<marker id="${idOpen}" viewBox="0 0 10 10" refX="9" refY="5" ` +
                "markerWidth=\"21\" markerHeight=\"21\" markerUnits=\"userSpaceOnUse\" " +
                "orient=\"auto-start-reverse\">",
            `<path d="M 0.6 1 L 9 5 L 0.6 9 z" class="${classOpen}"/>`,
            "</marker>"
        ] : []),
        "</defs>",
        ...svgGroups,
        ...svgContainers,
        ...svgShapes,
        ...svgEdges,
        ...svgJunctions,
        ...svgNodes,
        ...svgTexts,
        ...svgLabels,
        "</svg>",
        ""
    ].join("\n")
}

