/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  built-in dependencies  */
import crypto                                               from "node:crypto"

/*  external dependencies  */
import UUID                                                 from "pure-uuid"

/*  internal dependencies  */
import { Node, Edge }                                       from "./gradia-api-model.js"
import { Config, ConfigEmbedded, ConfigFontSize, resolveFont, cssValueOf, cssSizeOf }
    from "./gradia-api-config.js"
import { Poly, NodeStyle, Layout, GroupBox, ContainerBox, Shape,
    FS_GROUP, ARITY_OFF, ARITY_PAD, ARITY_GAP, ARROW_AIR, arityHeight, textWidth, escapeXML, shapeBox }
    from "./gradia-api-render-base.js"
import { linesOfNode, urlOf, typeOf, defaultStyleOf, containerHead,
    MIN_H, NAME_H, ATTR_H, ATTR_P, TYPE_H, TYPE_D, HEAD_H }
    from "./gradia-api-render-node.js"
import { computeHops, piecesOf, pathOf, pointAt }
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

/*  the UUID v5 of a name within the namespace of Gradia, in lower-case
    Base16 format: derived through the native SHA-1 of Node.js where
    available, hashing the very octets pure-uuid hashes (the namespace
    octets, followed by the low octet of every UTF-16 code unit of the
    name, which is exactly the "latin1" encoding of Node.js), and else,
    e.g. in the browser bundle with its stubbed built-ins, through
    pure-uuid itself (whose SHA-1 in pure JavaScript is far slower)  */
const sha1Native = (() => {
    try {
        if (typeof crypto.createHash !== "function")
            return undefined
        const ns = Buffer.from(NS_GRADIA.replace(/-/g, ""), "hex")
        return (name: string): string => {
            const hash = crypto.createHash("sha1").update(ns).update(name, "latin1").digest()
            hash[6] = (hash[6] & 0x0F) | 0x50
            hash[8] = (hash[8] & 0x3F) | 0x80
            return hash.subarray(0, 16).toString("hex")
        }
    }
    catch {
        return undefined
    }
})()
const uuidOf = (name: string): string =>
    sha1Native !== undefined ? sha1Native(name) : new UUID(5, NS_GRADIA, name).format("b16").toLowerCase()

/*  derive a per-document identifier prefix from a seed, as the SVG
    identifiers are DOM-global and would collide once multiple diagrams
    are embedded into the very same document. The prefix is derived from
    the UUID v5 of the seed and hence stays stable across regenerations
    of an unchanged diagram (the Base16 format keeps it alphanumeric and
    thus a valid XML name and CSS/URL fragment, and its leading 12 digits
    keep the identifiers short, as every edge references one, while
    still making a collision among the diagrams of a document unlikely)  */
const idPrefix = (seed: string): string =>
    `gradia-${uuidOf(seed).slice(0, 12)}`

/*  the CSS class names, derived from the UUID v5 of their declarations
    (see "classOf" below), cached across the rendered documents, as the
    very same declarations recur in nearly every document (bounded, as
    a long-running process may see arbitrarily many configurations)  */
const CLASS_CACHE_MAX = 4096
const classNames = new Map<string, string>()
const classNameOf = (decls: string): string => {
    let name = classNames.get(decls)
    if (name === undefined) {
        name = `gradia-${uuidOf(decls).slice(0, 8)}`
        if (classNames.size >= CLASS_CACHE_MAX)
            classNames.clear()
        classNames.set(decls, name)
    }
    return name
}

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

/*  the radius of the dot marking a junction of bundled edges, where an
    edge joins or leaves the track it shares with the other edges of its
    bundle (clearly wider than an edge line, but far below an arrow head)  */
const JUNCTION_R = 5

/*  the gap a name label on the stub of a bundled edge keeps in front of
    the shared track, clear of the junction dot there and of the
    clearance a label keeps from the foreign lines of that track  */
const STUB_GAP = 16

/*  the clearance a label keeps from a foreign edge line, as a label
    merely not overlapping such a line still reads as its annotation  */
const LINE_GAP = 12

/*  the gap between two arity labels set back one behind the other along
    one and the same edge line, and the number of such setbacks tried  */
const ARITY_STEP = 8
const ARITY_BACK = 3

/*  the step by which the anchor of a name label is set back along the
    stub arriving at the target, where its foremost position is taken,
    and the air the anchored label keeps from the boxes and labels
    beside it on that stub (below the gap to its arity)  */
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
    claim:    (candidates: Box[], edge: number, dodge?: boolean, own?: Box, mates?: Set<number>) => Box,
    seize:    (box: Box, edge: number) => boolean,
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
        the "mates" of the edge, the other edges of a group labeled once,
        count as own lines, as they run on top of the own line)  */
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
    const crossings = (box: Box, edge: number, limit: number, mates?: Set<number>, gap = LINE_GAP): number => {
        const [ x1, y1, x2, y2 ] = [ box[0] - gap, box[1] - gap, box[2] + gap, box[3] + gap ]
        let n = 0
        lineGrid.visit(x1, y1, x2, y2, (id, o) => {
            if (owner[id] === edge || mates?.has(owner[id]) === true ?
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
    const claim = (candidates: Box[], edge: number, dodge = true, own?: Box, mates?: Set<number>): Box => {
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

    /*  claim a single box only if it is free, i.e., if it collides with
        no occupied or reserved area (with some air beside it) and no
        foreign edge line runs within it (without any clearance, as the
        box is the fixed anchor of its label, which is attributed to its
        edge by that very position and not by its distance to the
        foreign lines), and tell whether it was claimed  */
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

/*  the preferred positions of the name labels of the bundled edges: on
    the stub feeding the shared track of the edge (or else on the stub
    leaving it), flush toward the track and above its line (or else, if
    the stubs run too closely for this, below it), so the labels of all
    stubs of a bundle line up in front of the track instead of
    scattering along the stubs  */
const stubLabels = (layout: Layout, config: Config): Map<number, Box[]> => {
    const { edges, polys } = layout
    const anchors = new Map<number, Box[]>()
    const bundled = (i: number): boolean => layout.bundled?.[i] === true
    if (!edges.some((edge, i) => bundled(i) && edge.name !== undefined))
        return anchors

    /*  index the owners of the vertical segments of the bundled edges by
        their X position, to tell the segments on a shared track (even
        where the segment of an edge does not overlap the others, as
        its stub still belongs to the stubs of the bundle), and their
        horizontal segments by their Y position, to tell a stub of its
        own from a shared horizontal track  */
    const verts = new Map<number, Set<number>>()
    const horzs = new Map<number, { lo: number, hi: number, owner: number }[]>()
    polys.forEach((poly, i) => {
        if (!bundled(i))
            return
        for (let k = 0; k < poly.length - 1; k++) {
            const [ a, b ] = [ poly[k], poly[k + 1] ]
            if (a[0] === b[0]) {
                const owners = verts.get(a[0])
                if (owners === undefined)
                    verts.set(a[0], new Set([ i ]))
                else
                    owners.add(i)
            }
            else {
                const seg  = { lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), owner: i }
                const list = horzs.get(a[1])
                if (list === undefined)
                    horzs.set(a[1], [ seg ])
                else
                    list.push(seg)
            }
        }
    })
    const shared = (i: number, a: [ number, number ], b: [ number, number ]): boolean =>
        a[0] === b[0] && Array.from(verts.get(a[0]) ?? []).some((owner) => owner !== i)
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
    segment of its route, above its line and flush toward its end, i.e.,
    on the stub arriving at the target node right in front of the arity
    (or, without one, flush with its setback from the arrow head) and on
    the baseline of the arity, or, for a route ending in a vertical run,
    right in front of the corner turning into that run, so every name
    sits at the very same spot of its edge, and else, where that spot is
    taken (e.g. by a box beside a lane between two boxes), at the
    positions stepping back from there along that very segment, as far
    as it holds the label clear of the corner at its other end  */
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
    edges, whose ends were merged into one port, on the single stub
    between their shared track and that port, above the line like the
    arity: at the port they run into at the anchor of a single edge (see
    "arrivalLabels" above), and at the port they run out of flush with
    the box (or else below the line)  */
const portLabels = (edge: Edge, poly: Poly, into: boolean, config: Config): Box[] => {
    if (edge.name === undefined)
        return []
    if (into) {
        const anchors = arrivalLabels(edge, poly, config)
        return poly[poly.length - 2][1] === poly[poly.length - 1][1] ? anchors.slice(0, 1) : []
    }
    const w = textWidth(edge.name, config["size-font-edge"])
    const h = config["size-font-edge"] + 4
    const [ a, b ] = [ poly[1], poly[0] ]
    if (a[1] !== b[1])
        return []
    const dir = Math.sign(b[0] - a[0])
    const x1  = Math.min(b[0] - dir * STUB_GAP, b[0] - dir * (STUB_GAP + w))
    const x2  = Math.max(b[0] - dir * STUB_GAP, b[0] - dir * (STUB_GAP + w))
    return [ [ x1, b[1] - 3 - h, x2, b[1] - 3 ], [ x1, b[1] + 3, x2, b[1] + 3 + h ] ]
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

/*  generate the SVG fragment for the name label of a single edge at its
    claimed position, centered on it, or else aligned to its start or end
    (as the estimated text width may deviate from the rendered one, and
    a label anchored in front of an arrow head shall stay flush with it)  */
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
    const dash = shape.kind !== "text" && shape.dash !== undefined ?
        ` stroke-dasharray="${escapeXML(shape.dash)}"` : ""
    if (shape.kind === "rect")
        return `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" ` +
            `rx="${shape.rx ?? 0}" class="${styler.box(shape.fill, shape.stroke, shape.width)}"${dash}/>`
    else if (shape.kind === "path")
        return `<path d="M ${shape.x} ${shape.y} ${shape.d}" class="${styler.line(shape.stroke, shape.width)}"${dash}/>`
    const text = `<text x="${shape.x}" y="${shape.y}" class="${styler.text(shape.fill, shape.size,
        { bold: shape.bold, middle: shape.anchor === "middle", end: shape.anchor === "end" })}">` +
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
    const idAlert = `${prefix}-alert`

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
            name = classNameOf(decls)
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

    /*  an edge violating a rule of its diagram type (e.g. pointing
        upwards in a layered diagram) is drawn dashed in the violation
        color, with an arrow head of that color  */
    const violates   = layout.violates ?? (() => false)
    const alerted    = edges.some((edge) => violates(edge))
    const classAlert = alerted ? classOf(`fill: none; stroke: ${color("color-edge-violation")}; stroke-width: 3; ` +
        "stroke-dasharray: 10 6") : ""
    const classAlertArrow = alerted ? classOf(`fill: ${color("color-edge-violation")}`) : ""

    /*  detect the edge crossings requiring rendered hops  */
    const hops = computeHops(polys)

    /*  prepare the collision-free placement of the edge labels  */
    const { claim, seize, reserve, occupied } = labelPlacer(layout, hops, config["size-edge-hop-radius"], config)

    /*  generate the SVG fragments for the edge paths (sharply turning
        at the junctions of bundled edges, and bridging the runs of
        closely spaced crossings in a diagram with crowded channels or
        gutters) and the dots marking those junctions on top of them,
        where the bundled edges whose ends were merged into one port
        form a group, standing for all of them, whose first edge alone
        draws the arrow head and the arity at that port, and where the
        segments shared by bundled edges are drawn by the first of them
        only (see "piecesOf"), with the crossing hops still determined
        on the whole polylines, as the shared segments lie exactly on
        top of each other and hence hop over the same crossings  */
    const junctions  = layout.junctions ?? []
    const junctionAt = new Set(junctions.map(([ x, y ]) => `${x}:${y}`))
    const junction   = junctionAt.size > 0 ? (x: number, y: number) => junctionAt.has(`${x}:${y}`) : undefined
    const groupsAt = (end: (poly: Poly) => [ number, number ]): Map<number, number[]> => {
        const byPort = new Map<string, number[]>()
        polys.forEach((poly, i) => {
            if (layout.bundled?.[i] !== true)
                return
            const key  = `${end(poly)[0]}:${end(poly)[1]}`
            const list = byPort.get(key)
            if (list === undefined)
                byPort.set(key, [ i ])
            else
                list.push(i)
        })
        const groups = new Map<number, number[]>()
        for (const list of byPort.values())
            if (list.length > 1)
                groups.set(list[0], list)
        return groups
    }
    const into    = groupsAt((poly) => poly[poly.length - 1])
    const outOf   = groupsAt((poly) => poly[0])
    const grouped = new Set([ ...into.values(), ...outOf.values() ].flat())
    const repeat  = edges.map(() => false)
    for (const list of into.values())
        for (const i of list.slice(1))
            repeat[i] = true
    const svgEdges = piecesOf(polys, layout.bundled).flatMap((pieces, i) => pieces.map((piece) =>
        `<path d="${pathOf(polys[i], hops[i], config["size-edge-corner-radius"], config["size-edge-hop-radius"],
            junction, layout.crowded === true, piece)}" ` +
        `class="${violates(edges[i]) ? classAlert : classEdge}"` +
        (repeat[i] || !piece.end ? "/>" : ` marker-end="url(#${violates(edges[i]) ? idAlert : idArrow})"/>`)))
    const svgJunctions = junctions.map(([ x, y ]) =>
        `<circle cx="${x}" cy="${y}" r="${JUNCTION_R}" class="${classArrow}"/>`)

    /*  reserve the position every arity label prefers -- the one beside
        its own arrow head -- before any name label is placed, as an
        arity is bound to that arrow while a name may slide along the
        whole route: a name hence yields the reserved area wherever it
        has an alternative, and only a name left without one takes it
        and pushes its arity onto the next setback  */
    const arities = edges.map((edge, i) =>
        edge.arity !== undefined && !repeat[i] ? arityBoxes(edge.arity, polys[i], config) : undefined)
    for (const candidates of arities)
        if (candidates !== undefined)
            reserve(candidates[0])

    /*  generate the SVG fragments for the edge labels (the names
        first, as their reservations keep the arity positions free),
        where the name of every edge not bundled with others first
        takes its anchor on the stub arriving at the target (see
        "arrivalLabels"), all of them before any name searches a
        position of its own, so no searched position takes the anchor of
        another name, and only a name whose anchor is missing or not
        free searches its position along the route  */
    const svgLabels: string[] = []
    const stubAt = stubLabels(layout, config)
    const placed = edges.map((edge, i) => {
        if (layout.bundled?.[i] === true)
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
                (c, dodge) => claim(c, i, dodge, undefined, mates !== undefined ? new Set(mates) : undefined),
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
        above the boxes and below the edges and nodes, in their order)  */
    const shapes    = layout.shapes ?? []
    const svgShapes = shapes.map((shape) => renderShape(shape, styler))

    /*  determine the overall bounding box of all rendered elements  */
    const groupBoxes: Box[] = groups.map((group) =>
        [ group.x, group.y, group.x + group.w, group.y + group.h ])
    const containerBoxes: Box[] = containers.map((c) =>
        [ c.x, c.y, c.x + c.w, c.y + c.h ])
    const vb = viewBoxOf(layout, [ ...occupied, ...groupBoxes, ...containerBoxes, ...shapes.map(shapeBox) ],
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
        ...(alerted ? [
            `<marker id="${idAlert}" viewBox="0 0 10 10" refX="9" refY="5" ` +
                "markerWidth=\"21\" markerHeight=\"21\" markerUnits=\"userSpaceOnUse\" " +
                "orient=\"auto-start-reverse\">",
            `<path d="M 0 1 L 9 5 L 0 9 z" class="${classAlertArrow}"/>`,
            "</marker>"
        ] : []),
        "</defs>",
        ...svgGroups,
        ...svgContainers,
        ...svgShapes,
        ...svgEdges,
        ...svgJunctions,
        ...svgNodes,
        ...svgLabels,
        "</svg>",
        ""
    ].join("\n")
}

