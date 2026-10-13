/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge, Graph }                       from "./gradia-api-model.js"
import { Config }                                  from "./gradia-api-config.js"
import { Poly, NodeStyle, Layout, ARITY_OFF, ARROW_AIR, onRaster, textWidth, arrowRoom, stubRoom }
    from "./gradia-api-render-base.js"
import { isPrimary, measureNodes, defaultStyleOf } from "./gradia-api-render-node.js"
import { LevelContext }                            from "./gradia-api-render-container.js"
import { Side, TrackUser, simplifyPoly, assignPorts, assignTracks, junctionsOf, portGapOf, PORT_PAD }
    from "./gradia-api-render-edge.js"

/*  the separator between a node id and its placement suffix,
    distinguishing the two clones of a twice-placed node and the
    output clone of a self-referencing primary node  */
const CLONE = "\u0000"

/*  rendering geometry constants  */
const CHAN_W1  = 28  /*  width of a one-edge inter-column channel    */
const CHAN_PAD = 16  /*  cross-axis padding inside a channel         */
const WRAP_GAP = 40  /*  min horizontal gap between two sub-columns  */
const WRAP_PAD = 8   /*  padding of an arity inside that gap         */
const LANE_PAD = 12  /*  clearance of an edge lane to a node box     */

/*  validate the constrained input topology and classify the declared
    nodes: exactly one node is annotated with "primary: true" and every
    edge connects the primary with another node. Each other node is
    classified as input (edges point toward the primary) and/or output
    (edges originate from the primary); a node referenced in both
    directions is placed twice, once in the input column and once in
    the output column, with its edges rewritten to attach to the
    corresponding placement. A self-loop on the primary is unrolled
    likewise, onto a clone of the primary in the output column  */
const classifyTopology = (graph: Graph): {
    center: Node, inputs: Node[], outputs: Node[], nodes: Node[], edges: Edge[]
} => {
    /*  determine the primary node and the ids of its input and output nodes  */
    const declared  = Array.from(graph.nodes.values())
    for (const node of declared)
        if (node.id.includes(CLONE))
            throw new Error(`node id ${JSON.stringify(node.id)} contains a reserved control character`)
    const primaries = declared.filter(isPrimary)
    if (primaries.length !== 1)
        throw new Error(`expected exactly one node annotated with "primary: true" (found ${primaries.length})`)
    const center   = primaries[0]
    const inSet    = new Set<string>()
    const outSet   = new Set<string>()
    let   selfLoop = false
    for (const edge of graph.edges) {
        if (edge.source === center.id && edge.target === center.id)
            selfLoop = true
        else if (edge.target === center.id)
            inSet.add(edge.source)
        else if (edge.source === center.id)
            outSet.add(edge.target)
        else
            throw new Error(`edge "${edge.source}" --> "${edge.target}" does not connect to primary node "${center.id}"`)
    }

    /*  classify every non-primary node into the input and/or output column  */
    const dual = new Set<string>()
    const inputs:  Node[] = []
    const outputs: Node[] = []
    for (const node of declared) {
        if (node.id === center.id)
            continue
        const isInput  = inSet.has(node.id)
        const isOutput = outSet.has(node.id)
        if (!isInput && !isOutput)
            throw new Error(`node "${node.id}" is neither input nor output of primary node "${center.id}"`)
        if (isInput && isOutput) {
            dual.add(node.id)
            inputs.push({  ...node, id: node.id + CLONE + "in"  })
            outputs.push({ ...node, id: node.id + CLONE + "out" })
        }
        else if (isInput)
            inputs.push(node)
        else
            outputs.push(node)
    }

    /*  place the clone of a self-referencing primary node (stripped of
        its "primary" annotation) on top of the output column  */
    if (selfLoop)
        outputs.unshift({ ...center, id: center.id + CLONE + "self",
            attrs: center.attrs.filter((attr) => attr.key !== "primary") })

    /*  rewrite the edges of the twice-placed nodes onto their clones  */
    const edges = graph.edges.map((edge) => {
        if (edge.source === center.id && edge.target === center.id)
            return { ...edge, target: edge.target + CLONE + "self" }
        else if (edge.target === center.id && dual.has(edge.source))
            return { ...edge, source: edge.source + CLONE + "in" }
        else if (edge.source === center.id && dual.has(edge.target))
            return { ...edge, target: edge.target + CLONE + "out" }
        else
            return edge
    })
    return { center, inputs, outputs, nodes: [ center, ...inputs, ...outputs ], edges }
}

/*  lay out a hub graph model (N input nodes, one central hub node, M
    output nodes), for a containment level with the container placeholders
    at their fixed sizes and the edge ends attaching to them at their
    fixed ports  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  validate the constrained input topology and classify the
        declared nodes into the input and output columns  */
    const { center, inputs, outputs, nodes, edges } = classifyTopology(graph)
    const inputSet = new Set(inputs.map((node) => node.id))

    /*  resolve the configurable rendering geometry  */
    const margin = config["size-canvas-margin"]
    const gap    = config["hub-node-gap"]
    const scale  = config["size-node-height-scale"]

    /*  the fixed three-column layout assignment  */
    const colOf = (id: string): number =>
        id === center.id ? 1 : (inputSet.has(id) ? 0 : 2)

    /*  the attachment sides of every edge (east/west): every edge runs
        from the input toward the output column (see classifyTopology),
        hence leaves on the east and enters on the west side  */
    const sides: { s: Side, t: Side }[] = edges.map(() => ({ s: "e", t: "w" }))

    /*  determine node box sizes from their textual content (all boxes
        at half height scale)  */
    const { boxW, boxH, contentH } = measureNodes(nodes, config, () => scale / 2, level.fixedSize)

    /*  align the boxes on a raster: every box of the input and of the
        output column takes the width and the height of the widest and
        the highest box of its column, both rounded up to the raster
        step, so the boxes of a column, wrapped or not, line up evenly
        (the fixed-size boxes of a containment level are exempt)  */
    for (const column of [ inputs, outputs ]) {
        const free   = column.filter((node) => !level.fixedSize?.has(node.id))
        const width  = onRaster(free.reduce((w, node) => Math.max(w, boxW.get(node.id)!), 0))
        const height = onRaster(free.reduce((h, node) => Math.max(h, boxH.get(node.id)!), 0))
        for (const node of free) {
            boxW.set(node.id, width)
            boxH.set(node.id, height)
        }
    }
    if (!level.fixedSize?.has(center.id))
        boxH.set(center.id, onRaster(boxH.get(center.id)!))

    /*  the ports, the channel sizes and the column placement, all
        determined by "place" below, for the edge ends merged into one
        port, once determined  */
    const sizedH   = new Map(boxH)
    const portCnt  = new Map<string, number>()
    const outerSet = new Set<string>()
    const nodeCY   = new Map<string, number>()
    const colLX: number[] = []
    let   portGap  = portGapOf(edges, config)
    let   outerW   = [ 0, 0 ]
    let   colWidth = [ 0, 0, 0 ]
    let   chanW    = [ 0, 0 ]
    const chanOf   = (edge: Edge): number =>
        Math.min(colOf(edge.source), colOf(edge.target))

    /*  place the nodes within their (sub-)column: input nodes
        right-aligned, output nodes left-aligned, and the center node
        centered  */
    const cx = (id: string): number => {
        const c = colOf(id)
        if (c === 0)
            return colLX[0] + (outerSet.has(id) ? outerW[0] : colWidth[0]) - boxW.get(id)! / 2
        else if (c === 2)
            return colLX[2] + (outerSet.has(id) ? colWidth[2] - outerW[1] : 0) + boxW.get(id)! / 2
        else
            return colLX[1] + colWidth[1] / 2
    }
    const cy = (id: string): number => nodeCY.get(id)!

    /*  lay out the nodes and route the edges  */
    const place = (merged?: (edge: number, role: "s" | "t") => string | undefined) => {
        /*  grow every box up to the height hosting all of its edge
            attachments at the full port separation, and the one whose
            attachments exceed the configured per-side maximum
            additionally step-wise by one separation per additional edge,
            so the ports of a node never pack tighter than configured,
            however small its content height is (the edge ends merged
            into one port counting as one, and the fixed-size boxes of a
            containment level are exempt)  */
        portGap = portGapOf(edges, config, merged)
        portCnt.clear()
        edges.forEach((edge, i) => {
            portCnt.set(`${sides[i].s}:${edge.source}`, (portCnt.get(`${sides[i].s}:${edge.source}`) ?? 0) + 1)
            portCnt.set(`${sides[i].t}:${edge.target}`, (portCnt.get(`${sides[i].t}:${edge.target}`) ?? 0) + 1)
        })
        if (merged !== undefined) {
            const seen = new Set<string>()
            edges.forEach((edge, i) => {
                for (const [ role, id ] of [ [ "s", edge.source ], [ "t", edge.target ] ] as const) {
                    const m = merged(i, role)
                    if (m === undefined)
                        continue
                    const key = `${sides[i][role]}:${id}`
                    if (seen.has(m))
                        portCnt.set(key, portCnt.get(key)! - 1)
                    else
                        seen.add(m)
                }
            })
        }
        for (const node of nodes) {
            if (level.fixedSize?.has(node.id))
                continue
            const cnt   = Math.max(portCnt.get(`w:${node.id}`) ?? 0, portCnt.get(`e:${node.id}`) ?? 0)
            const extra = Math.max(0, cnt - config["hub-node-degree-max"])
            boxH.set(node.id, Math.max(
                sizedH.get(node.id)! + extra * portGap(node.id), cnt * portGap(node.id) + PORT_PAD))
        }

        /*  a stack of more nodes than the configured maximum wraps into
            two staggered sub-columns: its nodes alternate between the
            outer sub-column and the inner one (adjacent to the channel),
            and every outer node is vertically centered onto a gap
            between two inner nodes, through which its edges reach the
            channel on their straight horizontal lanes (so the edge
            routing is unaffected). The configured maximum decides for
            the larger stack alone, as the height of the diagram follows
            that one: the tallest (sub-)column it ends up with implicitly
            caps the smaller stack, which hence wraps exactly if that
            lowers the height of the diagram  */
        const countMax = config["hub-node-count-max"]
        const bySize   = inputs.length >= outputs.length ? [ inputs, outputs ] : [ outputs, inputs ]
        const wrapped  = [ countMax > 0 && bySize[0].length > countMax, false ]
        const capped   = wrapped[0] ? Math.ceil(bySize[0].length / 2) : bySize[0].length
        wrapped[1]     = countMax > 0 && bySize[1].length > capped
        outerSet.clear()
        for (const [ c, list ] of bySize.entries())
            if (wrapped[c])
                list.filter((_, k) => k % 2 === 0).forEach((node) => outerSet.add(node.id))

        /*  the vertical half extent of the lane the edges of an outer
            node occupy around its center: its ports at their maximum
            separation plus the clearance to the inner node boxes (a
            fixed-size box carries its ports at fixed positions anywhere
            along its side, so its lane spans its entire height)  */
        const laneOf = (id: string): number => {
            const cnt = Math.max(portCnt.get(`w:${id}`) ?? 0, portCnt.get(`e:${id}`) ?? 0)
            return level.fixedSize?.has(id) ? boxH.get(id)! / 2 :
                Math.min(boxH.get(id)! / 2, (cnt - 1) * portGap(id) / 2 + LANE_PAD)
        }

        /*  fixed three-column layout: stack the input nodes in the first
            column and the output nodes in the third column (each stack
            vertically centered), and place the center node in the second
            column at the vertical center of the canvas, where an outer
            node keeps its lane clear of the inner nodes above and below it  */
        const stackY = new Map<string, number>()
        const stack  = (list: Node[]): number => {
            let [ innerB, outerB, laneB, bottom ] = [ -Infinity, -Infinity, -Infinity, 0 ]
            for (const node of list) {
                const h = boxH.get(node.id)!
                let   y = h / 2
                if (outerSet.has(node.id)) {
                    y      = Math.max(y, outerB + gap + h / 2, innerB + laneOf(node.id))
                    outerB = y + h / 2
                    laneB  = y + laneOf(node.id)
                }
                else {
                    y      = Math.max(y, innerB + gap + h / 2, laneB + h / 2)
                    innerB = y + h / 2
                }
                stackY.set(node.id, y)
                bottom = Math.max(bottom, y + h / 2)
            }
            return bottom
        }
        const stackH = [ stack(inputs), stack(outputs) ]
        const totalH = Math.max(stackH[0], boxH.get(center.id)!, stackH[1])
        nodeCY.clear()
        for (const [ c, list ] of [ inputs, outputs ].entries())
            for (const node of list)
                nodeCY.set(node.id, margin + (totalH - stackH[c]) / 2 + stackY.get(node.id)!)
        nodeCY.set(center.id, margin + totalH / 2)

        /*  determine column widths and left edge positions, with the two
            inter-column channel widths sized by actual edge usage (a
            wrapped column spans its two sub-columns and their gap, which
            holds the arities set back from the arrow heads at its outer
            nodes, as the lanes between the inner nodes have no room)  */
        const subWidth = (list: Node[], outer: boolean): number =>
            list.filter((node) => outerSet.has(node.id) === outer)
                .reduce((a, node) => Math.max(a, boxW.get(node.id)!), 0)
        outerW = [ subWidth(inputs, true), subWidth(outputs, true) ]
        const wrapGap  = edges.reduce((a, edge) => outerSet.has(edge.target) && edge.arity !== undefined ?
            Math.max(a, ARITY_OFF + textWidth(edge.arity, config["size-font-arity"]) + WRAP_PAD) : a, WRAP_GAP)
        const sideW    = (list: Node[], c: number): number =>
            subWidth(list, false) + (outerW[c] > 0 ? (c === 1 ? wrapGap : WRAP_GAP) + outerW[c] : 0)
        colWidth = [ sideW(inputs, 0), boxW.get(center.id)!, sideW(outputs, 1) ]
        const chanCnt  = [
            edges.filter((edge) => chanOf(edge) === 0).length,
            edges.filter((edge) => chanOf(edge) === 1).length
        ]
        chanW = chanCnt.map((cnt) =>
            Math.min(config["hub-channel-width-max"], Math.max(config["hub-channel-width-min"],
                CHAN_W1 + (cnt - 1) * config["size-edge-track-gap"])))
        const placeColumns = () => {
            let x = margin
            for (let c = 0; c < 3; c++) {
                colLX[c] = x
                x += colWidth[c] + (c < 2 ? chanW[c] : 0)
            }
        }
        placeColumns()

        /*  distribute the edge attachment ports along each node side  */
        let portPos = assignPorts(edges, sides, cx, cy, boxW, boxH, portGap,
            undefined, level.fixedPort, merged)

        /*  assign the vertical tracks within each channel (see
            assignTracks for the crossing-avoiding ordering scheme; a hub
            graph has no backward edges, hence no channel user is ever
            mirrored, and a crowded channel bundles the edges of the same
            name sharing their target with the same arity, or else their
            source, i.e., at least all the edges of the same name ending
            at the primary node with the same arity, where the edges
            whose ends were merged into one port stay bound to their
            bundle)  */
        const chanUsers: TrackUser[][] = [ [], [] ]
        edges.forEach((edge, i) => {
            chanUsers[chanOf(edge)].push({
                edge:    i,
                posIn:   portPos.get(`${i}:s`)!.y,
                posOut:  portPos.get(`${i}:t`)!.y,
                mirror:  false,
                bundles: [ `t:${JSON.stringify([ edge.target, edge.arity ?? null, edge.name ?? null ])}`,
                    `s:${JSON.stringify([ edge.source, edge.name ?? null ])}` ],
                unit:    merged?.(i, "t") ?? merged?.(i, "s")
            })
        })
        const chanOff = new Map<string, number>()
        const bundled = new Map<number, string>()
        const shift   = [ 0, 0 ]
        let   grown   = false
        let   crowded = false
        chanUsers.forEach((users, c) => {
            /*  a channel holding a bundle which runs into (or out of) its
                node through one merged port keeps that run long enough
                for the labels of the bundle placed there  */
            const frame  = Math.max(CHAN_W1, 2 * arrowRoom(config))
            const reach  = users.reduce((max, u) =>
                u.unit !== undefined ? Math.max(max, 2 * stubRoom(edges[u.edge], config)) : max, frame)
            const tracks = assignTracks(users, chanW[c], CHAN_PAD, config["size-edge-track-gap"],
                config["size-edge-track-gap-min"], reach)
            for (const [ edge, off ] of tracks.offsets)
                chanOff.set(`${c}:${edge}`, off)
            for (const [ edge, key ] of tracks.bundled)
                bundled.set(edge, key)
            crowded ||= tracks.need > 0
            if (tracks.need > chanW[c]) {
                chanW[c] = tracks.need
                grown    = true
            }

            /*  keep the stub of every edge arriving at its node right of
                the channel (as every edge runs from the left toward the
                right) long enough for its name and arity labels placed
                there, side by side in front of its arrow head, by
                shifting the tracks toward the nodes left of the channel
                as far as needed, and by growing the channel beyond that,
                while the stubs leaving those nodes keep the room of a
                corner (or, for a bundle running out of its node through
                one merged port, the room of its name label placed there),
                where the bundled edges not merged into one port are
                exempt, as their names are placed on the stubs feeding
                their shared track  */
            if (users.length === 0)
                return
            const offs   = users.map((u) => tracks.offsets.get(u.edge)!)
            const [ lo, hi ] = [ Math.min(...offs), Math.max(...offs) ]
            const arrive = users.reduce((max, u) => edges[u.edge].name !== undefined
                && (!tracks.bundled.has(u.edge) || merged?.(u.edge, "t") !== undefined) ?
                Math.max(max, stubRoom(edges[u.edge], config)) : max, arrowRoom(config))
            const depart = users.reduce((max, u) => merged?.(u.edge, "s") !== undefined ?
                Math.max(max, stubRoom(edges[u.edge], config)) : max, config["size-edge-corner-radius"] + ARROW_AIR)
            if (depart + hi - lo + arrive > chanW[c]) {
                chanW[c] = depart + hi - lo + arrive
                grown    = true
            }
            shift[c] = Math.min(0, chanW[c] / 2 - arrive - hi)
        })

        /*  grow a crowded channel whose bundled tracks do not fit even at
            the minimum track gap, and a channel whose tracks do not leave
            the room of the labels on the stubs arriving at its nodes,
            beyond its configured maximum (but never shrink it, as the
            edge names placed along the short stubs between its tracks
            and the primary node need its room), which shifts the columns
            right of it and hence the ports there (but none of the
            vertical port positions the tracks were assigned by)  */
        if (grown) {
            placeColumns()
            portPos = assignPorts(edges, sides, cx, cy, boxW, boxH, portGap,
                undefined, level.fixedPort, merged)
        }

        /*  determine the X position of an edge's assigned track within a channel  */
        const chanX = (c: number, edge: number): number => colLX[c] + colWidth[c] + chanW[c] / 2 + shift[c] +
            chanOff.get(`${c}:${edge}`)!

        /*  route every edge as an orthogonal polyline through its channel  */
        const polys = edges.map((edge, i) => {
            const sp = portPos.get(`${i}:s`)!
            const tp = portPos.get(`${i}:t`)!
            const ch = chanX(chanOf(edge), i)
            let pts: Poly
            if (sp.y === tp.y)
                pts = [ [ sp.x, sp.y ], [ tp.x, tp.y ] ]
            else
                pts = [ [ sp.x, sp.y ], [ ch, sp.y ], [ ch, tp.y ], [ tp.x, tp.y ] ]
            return simplifyPoly(pts)
        })
        return { polys, bundled, crowded }
    }
    let placed = place()

    /*  let the bundles (of edges of the same name) leading to the same
        node with the same arity run into it as one, and the bundles
        coming from the same node run out of it as one: merge the edge ends of every such bundle (not
        attaching at a fixed port) into one port, which frees the ports
        of the others, so the boxes are sized and the edges are laid out
        anew  */
    const ends  = new Map<string, string>()
    const count = new Map<string, number>()
    for (const [ i, key ] of placed.bundled) {
        const role = key.startsWith("t:") ? "t" : "s"
        if (level.fixedPort?.(i, role) !== undefined)
            continue
        const end = `${chanOf(edges[i])}:${key}`
        ends.set(`${i}:${role}`, end)
        count.set(end, (count.get(end) ?? 0) + 1)
    }
    for (const [ end, key ] of ends)
        if (count.get(key)! < 2)
            ends.delete(end)
    if (ends.size > 0)
        placed = place((edge, role) => ends.get(`${edge}:${role}`))
    const { polys, bundled, crowded } = placed

    /*  mark the junctions of the bundled edges  */
    const junctions = junctionsOf(Array.from(bundled.keys(), (i) => polys[i]))

    /*  hand over the laid out graph for SVG rendering (the output copy
        of a twice-placed node is rendered as a dashed grey "ghost" box,
        the output clone of a self-referencing primary node as a dashed,
        darker grey "self" box, and all other boxes get the default
        primary/regular coloring)  */
    const styleOf = (node: Node): NodeStyle =>
        node.id.endsWith(CLONE + "out") ? {
            fill:   "color-node-ghost-box",
            stroke: "color-node-ghost-border",
            text:   "color-node-ghost-name",
            dash:   "10 6"
        } : node.id.endsWith(CLONE + "self") ? {
            fill:   "color-node-self-box",
            stroke: "color-node-self-border",
            text:   "color-node-self-name",
            dash:   "10 6"
        } : defaultStyleOf(node)
    return { nodes, edges, cx, cy, boxW, boxH, contentH, polys, styleOf,
        bundled: edges.map((_, i) => bundled.has(i)), junctions, crowded }
}

