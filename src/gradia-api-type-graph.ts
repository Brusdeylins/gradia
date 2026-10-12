/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  external dependencies  */
import { DagreLayout } from "@antv/layout"

/*  internal dependencies  */
import { Graph, Node, Edge }                 from "./gradia-api-model.js"
import { Config }                            from "./gradia-api-config.js"
import { Poly, ARITY_OFF, textWidth, arrowRoom, stubRoom, Layout }
    from "./gradia-api-render-base.js"
import { measureNodes, orderOf }             from "./gradia-api-render-node.js"
import { LevelContext, GateSide }            from "./gradia-api-render-container.js"
import { Side, TrackUser, simplifyPoly, assignPorts, assignTracks, computeHops,
    junctionsOf, portGapOf, PORT_PAD }
    from "./gradia-api-render-edge.js"

/*  rendering geometry constants  */
const CLUSTX   = 26  /*  max X distance within a grid column         */
const CLUSTY   = 72  /*  max Y distance within a grid row            */
const CHAN_W0  = 24  /*  width of an edge-less inter-column channel  */
const CHAN_W1  = 28  /*  width of a one-edge inter-column channel    */
const CHAN_PAD = 16  /*  cross-axis padding inside a channel         */
const CHAN_LBL = 8   /*  padding beside an edge label in a channel   */
const GUT_H0   = 20  /*  height of an edge-less inter-row gutter     */
const GUT_H1   = 24  /*  height of a one-edge inter-row gutter       */
const GUT_PAD  = 12  /*  cross-axis padding inside a gutter          */
const GUT_LBL  = 22  /*  clearance above/below a label in a gutter   */
const LOOP_TOP = 52  /*  detour of a self-loop above its node box    */

/*  node nudging constants  */
const NUDGE_GAP    = 24  /*  min port distance of a nudged node from its gutter tracks  */
const NUDGE_PASSES = 3   /*  max number of node nudging passes                          */
const NUDGE_EDGES  = 300 /*  max number of edges for which nodes are nudged at all      */

/*  the maximum number of passes sizing the crowded channels and gutters  */
const GROW_PASSES = 4

/*  snap raw node positions onto a discrete grid by clustering the
    distinct X coordinates into columns and Y coordinates into rows  */
const snapToGrid = (
    nodes: Node[],
    rawX:  Map<string, number>,
    rawY:  Map<string, number>
): { col: Map<string, number>, row: Map<string, number>, ncols: number, nrows: number } => {
    /*  cluster the distinct values into representatives more than a threshold apart  */
    const cluster = (values: number[], threshold: number): number[] => {
        const sorted = Array.from(new Set(values)).sort((a, b) => a - b)
        const reps: number[] = []
        for (const v of sorted)
            if (reps.length === 0 || v - reps[reps.length - 1] > threshold)
                reps.push(v)
        return reps
    }
    const colReps = cluster(nodes.map((node) => rawX.get(node.id)!), CLUSTX)
    const rowReps = cluster(nodes.map((node) => rawY.get(node.id)!), CLUSTY)

    /*  determine the index of the representative nearest to a value
        (the lowest one on a tie), by a binary search for the first
        representative not below the value, as the representatives are
        sorted and hence only it and the one before it can be nearest  */
    const nearestIndexOf = (reps: number[], v: number): number => {
        let lo = 0
        let hi = reps.length
        while (lo < hi) {
            const m = (lo + hi) >>> 1
            if (reps[m] < v)
                lo = m + 1
            else
                hi = m
        }
        let below = lo - 1
        while (below > 0 && reps[below - 1] === reps[below])
            below--
        if (below < 0)
            return 0
        if (lo >= reps.length)
            return below
        return Math.abs(reps[below] - v) <= Math.abs(reps[lo] - v) ? below : lo
    }

    /*  assign every node to its nearest column and row  */
    const col = new Map<string, number>()
    const row = new Map<string, number>()
    for (const node of nodes)
        col.set(node.id, nearestIndexOf(colReps, rawX.get(node.id)!))

    /*  split every row in which two nodes of one and the same column
        collide (the global clustering drops the row between two
        same-column nodes whenever both lie within the threshold of the
        rows around them): the raw position of the colliding node off
        its row becomes a row of its own, until all cells are unique  */
    for (;;) {
        for (const node of nodes)
            row.set(node.id, nearestIndexOf(rowReps, rawY.get(node.id)!))
        const cells = new Map<number, Node>()
        let   split: number | undefined
        for (const node of nodes) {
            const cell  = row.get(node.id)! * colReps.length + col.get(node.id)!
            const other = cells.get(cell)
            if (other === undefined) {
                cells.set(cell, node)
                continue
            }
            const rep = rowReps[row.get(node.id)!]
            split = Math.abs(rawY.get(node.id)! - rep) > Math.abs(rawY.get(other.id)! - rep) ?
                rawY.get(node.id)! : rawY.get(other.id)!
            break
        }
        if (split === undefined)
            break
        rowReps.push(split)
        rowReps.sort((a, b) => a - b)
    }
    return { col, row, ncols: colReps.length, nrows: rowReps.length }
}

/*  append a value to the array stored under a key of a multi-map  */
const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
    const list = map.get(key)
    if (list === undefined)
        map.set(key, [ value ])
    else
        list.push(value)
}

/*  refine the row assignment: the raw Dagre ordering tends to fling
    low-degree nodes far away from their neighbors, so pull every
    node vertically toward the median row of its direct neighbors,
    as far as free grid cells permit. The pull is deliberately gentle
    to not compress the rows too aggressively: distant nodes are
    pulled only half the way, and single-row moves are performed
    only when they align the node with a direct neighbor in an
    adjacent column (thereby straightening that edge)  */
const refineRows = (
    nodes: Node[],
    edges: Edge[],
    col:   Map<string, number>,
    row:   Map<string, number>
): void => {
    const stride = nodes.reduce((max, node) => Math.max(max, col.get(node.id)! + 1), 1)
    const cells  = new Set<number>()
    for (const node of nodes)
        cells.add(row.get(node.id)! * stride + col.get(node.id)!)
    const neighborsOf = new Map<string, string[]>()
    for (const edge of edges) {
        if (edge.source === edge.target)
            continue
        pushTo(neighborsOf, edge.source, edge.target)
        pushTo(neighborsOf, edge.target, edge.source)
    }

    /*  pull every node toward the median row of its neighbors  */
    for (const node of nodes) {
        const nb = neighborsOf.get(node.id)
        if (nb === undefined)
            continue
        const rows    = nb.map((id) => row.get(id)!).sort((a, b) => a - b)
        const desired = rows[Math.floor((rows.length - 1) / 2)]
        const cur     = row.get(node.id)!
        const dist    = Math.abs(desired - cur)
        if (dist === 0)
            continue
        const dir = Math.sign(desired - cur)
        let target: number
        if (dist === 1) {
            const aligns = nb.some((id) => row.get(id) === desired
                && Math.abs(col.get(id)! - col.get(node.id)!) === 1)
            if (!aligns)
                continue
            target = desired
        }
        else
            target = cur + dir * Math.ceil(dist / 2)
        const c = col.get(node.id)!
        for (let r = target; r !== cur; r -= dir) {
            if (!cells.has(r * stride + c)) {
                cells.delete(cur * stride + c)
                cells.add(r * stride + c)
                row.set(node.id, r)
                break
            }
        }
    }
}

/*  compact the rows of the grid, as the layered layout and the column
    folding leave many sparsely occupied rows behind: first lift every
    edge-less node (bound by no ordering constraint at all) into the
    topmost free cell of its column (unless the columns get packed
    anyway, where a lift gains no room but merely interleaves the
    edge-less nodes with the connected ones, so they stay below them),
    then merge every row into the row above it as long as no column is
    occupied in both (which keeps the vertical order of all nodes and the
    row alignment of the nodes sharing a row), and finally renumber the
    rows densely  */
const compactRows = (
    nodes: Node[],
    edges: Edge[],
    col:   Map<string, number>,
    row:   Map<string, number>,
    lift:  boolean
): number => {
    const stride = nodes.reduce((max, node) => Math.max(max, col.get(node.id)! + 1), 1)
    const cells  = new Set<number>()
    for (const node of nodes)
        cells.add(row.get(node.id)! * stride + col.get(node.id)!)

    /*  lift every edge-less node into the topmost free cell of its
        column (tracked per column, as it only ever moves downwards:
        a lifted node frees a cell below the one it takes)  */
    const linked = new Set<string>()
    for (const edge of edges) {
        linked.add(edge.source)
        linked.add(edge.target)
    }
    const isolated = !lift ? [] : nodes.filter((node) => !linked.has(node.id))
        .sort((a, b) => row.get(a.id)! - row.get(b.id)!)
    const topFree = new Map<number, number>()
    const freeFrom = (c: number, r: number): number => {
        while (cells.has(r * stride + c))
            r++
        return r
    }
    for (const node of isolated) {
        const c   = col.get(node.id)!
        const cur = row.get(node.id)!
        const r   = topFree.get(c) ?? freeFrom(c, 0)
        if (r < cur) {
            cells.delete(cur * stride + c)
            cells.add(r * stride + c)
            row.set(node.id, r)
            topFree.set(c, freeFrom(c, r + 1))
        }
        else
            topFree.set(c, r)
    }

    /*  merge every row into the row above it as long as no column is
        occupied in both, then renumber the rows densely  */
    const byRow = new Map<number, Node[]>()
    for (const node of nodes)
        pushTo(byRow, row.get(node.id)!, node)
    const rowMax   = Math.max(...byRow.keys())
    const rowIdx   = new Map<number, number>()
    let   idx      = -1
    let   occupied = new Set<number>()
    for (let r = 0; r <= rowMax; r++) {
        const members = byRow.get(r) ?? []
        if (idx < 0 || members.some((node) => occupied.has(col.get(node.id)!))) {
            idx++
            occupied = new Set<number>()
        }
        for (const node of members)
            occupied.add(col.get(node.id)!)
        rowIdx.set(r, idx)
    }
    for (const node of nodes)
        row.set(node.id, rowIdx.get(row.get(node.id)!)!)
    return idx + 1
}

/*  place the gate nodes of a containment level: the "in" gates into an
    additional first column and the "out" gates into an additional last
    column (both reserved for the gates, so the stubs from the container
    border to the gates never cross a node box), each gate into the row
    of the node its edge connects to, else into the nearest free row of
    the gate column, else into a row newly inserted below the wanted one  */
const placeGates = (
    gates: Map<string, GateSide>,
    edges: Edge[],
    col:   Map<string, number>,
    row:   Map<string, number>,
    ncols: number,
    nrows: number
): { ncols: number, nrows: number } => {
    const ins  = Array.from(gates).filter(([ , side ]) => side === "in").map(([ id ]) => id)
    const outs = Array.from(gates).filter(([ , side ]) => side === "out").map(([ id ]) => id)
    if (ins.length > 0) {
        for (const id of col.keys())
            col.set(id, col.get(id)! + 1)
        ncols++
    }
    if (outs.length > 0)
        ncols++
    const place = (ids: string[], c: number): void => {
        /*  the gates are placed in the order of their wanted rows, so
            the ones displaced into other rows never cross each other
            (the wanted row is the current row of the connected node,
            re-read per gate, as an inserted row shifts the nodes below)  */
        const otherOf = new Map<string, string>()
        for (const id of ids) {
            const edge = edges.find((edge) => edge.source === id || edge.target === id)!
            otherOf.set(id, edge.source === id ? edge.target : edge.source)
        }
        const wantOf = (id: string): number => row.get(otherOf.get(id)!)!
        ids.sort((a, b) => wantOf(a) - wantOf(b))
        /*  the rows taken by the gates placed so far (determined anew
            once an inserted row shifted them)  */
        const placed: string[] = []
        let   taken = new Set<number>()
        for (const id of ids) {
            const want = wantOf(id)
            let r: number | undefined
            for (let d = 0; r === undefined && d < nrows; d++) {
                if (want + d < nrows && !taken.has(want + d))
                    r = want + d
                else if (want - d >= 0 && !taken.has(want - d))
                    r = want - d
            }
            if (r === undefined) {
                for (const [ other, otherRow ] of row)
                    if (otherRow > want)
                        row.set(other, otherRow + 1)
                nrows++
                r = want + 1
                taken = new Set(placed.map((other) => row.get(other)!))
            }
            col.set(id, c)
            row.set(id, r)
            placed.push(id)
            taken.add(r)
        }
    }
    place(ins, 0)
    place(outs, ncols - 1)
    return { ncols, nrows }
}

/*  the coarse route of an edge: the inter-column channels and the
    inter-row gutters it occupies, per channel the way it passes
    through it (mirrored: entering from the right side, hairpin:
    leaving on the very side it entered from), and the end lying in
    the gutter: an edge reaching its gate node through a gutter ends
    there, straight through the gate-side channel, instead of climbing
    back into the row of the gate  */
interface RoutePlan {
    chans: number[]
    guts:  number[]
    flags: { mirror: boolean, hairpin: boolean }[]
    gate?: "s" | "t"
}

/*  the channels an edge runs a vertical track in (the gate-side
    channel of a gutter-ending edge is merely crossed horizontally)  */
const trackChans = (plan: RoutePlan): number[] =>
    plan.gate === "t" ? [ plan.chans[0] ] : plan.gate === "s" ? [ plan.chans[1] ] : plan.chans

/*  the channel an edge finally runs its stub out of into its target
    node, and whether that node lies right of the channel, i.e., the
    channel the name label of the edge lands in, on that stub (a
    self-loop and a gutter-ending edge end in no such stub)  */
const arrivalOf = (edge: Edge, plan: RoutePlan): { chan: number, right: boolean } | undefined => {
    if (edge.source === edge.target || plan.gate !== undefined)
        return undefined
    const flag = plan.flags[plan.flags.length - 1]
    return { chan: plan.chans[plan.chans.length - 1], right: flag.mirror === flag.hairpin }
}

/*  plan the coarse route of every edge: which inter-column channels
    and inter-row gutters it occupies (based on the grid indices and
    the attachment sides only): the source stub reaches the channel
    beside its attachment side, the target stub the channel beside
    its one, and, if those differ, the gutter next to the target row
    connects them (an edge whose gate end lies beyond that gutter ends
    in the gutter itself, as the gate merely marks the border passage)  */
const planRoutes = (
    edges: Edge[],
    col:   Map<string, number>,
    row:   Map<string, number>,
    sides: { s: Side, t: Side }[],
    gates: Map<string, GateSide>,
    config: Config
): { plans: RoutePlan[], chanCnt: Map<number, number>, gutCnt: Map<number, number>,
    chanLbl: Map<number, number>, gutLbl: Map<number, number>, gutLoop: Map<number, number> } => {
    const flag = (from: "l" | "r", to: "l" | "r") =>
        ({ mirror: from === "r", hairpin: from === to })
    const plans = edges.map((edge, i): RoutePlan => {
        /*  a self-loop detours as a hairpin through the channel beside
            its own node box (in from the near side and out on it again)  */
        const sc = col.get(edge.source)!
        if (edge.source === edge.target)
            return { chans: [ sc ], guts: [], flags: [ flag("l", "l") ] }
        const tc = col.get(edge.target)!
        const sr = row.get(edge.source)!
        const tr = row.get(edge.target)!
        const sChan = sides[i].s === "e" ? sc : sc - 1
        const tChan = sides[i].t === "w" ? tc - 1 : tc
        const sFrom = sides[i].s === "e" ? "l" : "r"
        const tTo   = sides[i].t === "w" ? "r" : "l"
        if (sChan === tChan)
            return { chans: [ sChan ], guts: [], flags: [ flag(sFrom, tTo) ] }
        const dir  = tChan > sChan ? "r" : "l"
        const gate = gates.has(edge.target) ? "t" : gates.has(edge.source) ? "s" : undefined
        return {
            chans: [ sChan, tChan ],
            guts:  [ tr > sr ? tr - 1 : tr ],
            flags: [ flag(sFrom, dir), flag(dir === "r" ? "l" : "r", tTo) ],
            gate
        }
    })

    /*  count the edges occupying each channel and gutter and determine
        the room the edge labels need there: a name is placed on the
        stub its edge finally runs out of its channel into the target
        node, beside its arity (see "stubRoom"), so that channel keeps
        the stubs on both of its sides long enough for the widest labels
        arriving there, beside all of its tracks, or else, for an edge
        ending in a gutter, the name is placed along its gutter run,
        costing one label line there; an arity is always placed in the
        channel through which its edge finally approaches the target
        node, set back from the arrow head (the labels of a self-loop
        land on its detour above the box and need no room)  */
    const chanCnt  = new Map<number, number>()
    const gutCnt   = new Map<number, number>()
    const chanLbl  = new Map<number, number>()
    const gutLbl   = new Map<number, number>()
    const chanArr  = new Map<number, [ number, number ]>()
    const chanNeed = (c: number, width: number) =>
        chanLbl.set(c, Math.max(chanLbl.get(c) ?? 0, width))
    plans.forEach((plan, i) => {
        const chans = trackChans(plan)
        for (const c of chans)
            chanCnt.set(c, (chanCnt.get(c) ?? 0) + 1)
        for (const g of plan.guts)
            gutCnt.set(g, (gutCnt.get(g) ?? 0) + 1)
        const { name, arity, source, target } = edges[i]
        if (source === target)
            return
        const arrival = arrivalOf(edges[i], plan)
        if (name !== undefined && arrival !== undefined) {
            const room = chanArr.get(arrival.chan) ?? [ 0, 0 ]
            room[arrival.right ? 1 : 0] = Math.max(room[arrival.right ? 1 : 0], stubRoom(edges[i], config))
            chanArr.set(arrival.chan, room)
        }
        else if (name !== undefined && plan.guts.length > 0)
            gutLbl.set(plan.guts[0], (gutLbl.get(plan.guts[0]) ?? 0) + 1)
        if (arity !== undefined)
            chanNeed(chans[chans.length - 1],
                ARITY_OFF + textWidth(arity, config["size-font-arity"]) + CHAN_LBL)
    })
    for (const [ c, [ left, right ] ] of chanArr)
        chanNeed(c, Math.max(left, arrowRoom(config)) + Math.max(right, arrowRoom(config)) +
            ((chanCnt.get(c) ?? 1) - 1) * config["size-edge-track-gap"])

    /*  count the self-loops of every node, as their detours stack up
        above its box and have to fit into the gutter above its row
        (the demand of a gutter is the deepest stack of any node below it)  */
    const loopCnt = new Map<string, number>()
    const gutLoop = new Map<number, number>()
    for (const edge of edges.filter((edge) => edge.source === edge.target)) {
        const cnt = (loopCnt.get(edge.source) ?? 0) + 1
        loopCnt.set(edge.source, cnt)
        const g = row.get(edge.source)! - 1
        gutLoop.set(g, Math.max(gutLoop.get(g) ?? 0, cnt))
    }
    return { plans, chanCnt, gutCnt, chanLbl, gutLbl, gutLoop }
}

/*  the computed grid geometry: the sizes of the columns and rows, the
    widths of the inter-column channels, the heights of the inter-row
    gutters (both as estimated from their edge count and capped by their
    configured maximum, by which their tracks are spread, and as finally
    sized, for the crowded ones by the needs of their bundled tracks),
    the resulting column/row/gutter center positions, and, for a grid
    with packed columns, the node center positions and the vertical
    shift range of every node (see packColumns)  */
interface Grid {
    colWidth:  number[]
    rowHeight: number[]
    chanCap:   number[]
    gutCap:    number[]
    chanW:     number[]
    gutH:      number[]
    colCX:     number[]
    rowCY:     number[]
    gutCY:     number[]
    nodeCY?:   Map<string, number>
    room?:     Map<string, [ number, number ]>
}

/*  the widths of the crowded channels and the heights of the crowded
    gutters needed by their bundled tracks  */
interface Need {
    chan: Map<number, number>
    gut:  Map<number, number>
}

/*  determine grid cell sizes and final node center positions, with
    channel widths and gutter heights sized by actual edge usage to
    keep the overall layout compact, except the crowded ones, which are
    sized by the needs of their bundled tracks  */
const computeGrid = (
    nodes:   Node[],
    col:     Map<string, number>,
    row:     Map<string, number>,
    boxW:    Map<string, number>,
    boxH:    Map<string, number>,
    ncols:   number,
    nrows:   number,
    chanCnt: Map<number, number>,
    gutCnt:  Map<number, number>,
    chanLbl: Map<number, number>,
    gutLbl:  Map<number, number>,
    gutLoop: Map<number, number>,
    need:    Need,
    config:  Config
): Grid => {
    const colWidth  = Array.from({ length: ncols }, () => 0)
    const rowHeight = Array.from({ length: nrows }, () => 0)
    for (const node of nodes) {
        colWidth[col.get(node.id)!]  = Math.max(colWidth[col.get(node.id)!],  boxW.get(node.id)!)
        rowHeight[row.get(node.id)!] = Math.max(rowHeight[row.get(node.id)!], boxH.get(node.id)!)
    }

    /*  size the channels and gutters by their actual edge usage (a used
        channel keeping its outermost tracks so far from the node boxes
        beside it, that an arrow head plus the corner in front of it plus
        some air fit in between, so neither a corner nor a hop of a
        crossing edge touches an arrow head), grown
        to hold the edge labels landing inside (a channel by its widest
        label demand, a gutter by one line per label) and the self-loop
        detours rising into a gutter from the row below, and floored by
        the configured minimum width/height  */
    const room    = arrowRoom(config)
    const chanOf  = (c: number, tracks: number) =>
        Math.min(config["graph-channel-width-max"],
            Math.max(config["graph-channel-width-min"], tracks, chanLbl.get(c) ?? 0))
    const gutOf   = (g: number, tracks: number) => {
        const lbl  = gutLbl.get(g)  ?? 0
        const loop = gutLoop.get(g) ?? 0
        return Math.min(config["graph-gutter-height-max"],
            Math.max(config["graph-gutter-height-min"], tracks,
                lbl  > 0 ? GUT_H1 + lbl * GUT_LBL : 0,
                loop > 0 ? LOOP_TOP + (loop - 1) * config["size-edge-track-gap"] + GUT_PAD : 0))
    }
    const chanCap = Array.from({ length: ncols }, (_, c) => {
        const cnt = chanCnt.get(c) ?? 0
        return chanOf(c, cnt === 0 ? CHAN_W0 : Math.max(CHAN_W1, 2 * room) +
            (cnt - 1) * config["size-edge-track-gap"])
    })
    const gutCap  = Array.from({ length: nrows }, (_, g) => {
        const cnt = gutCnt.get(g) ?? 0
        return gutOf(g, cnt === 0 ? GUT_H0 : GUT_H1 + (cnt - 1) * config["size-edge-track-gap"])
    })

    /*  size the crowded channels and gutters by the needs of their
        bundled tracks instead of by their edge count, which shrinks them
        below their capped size or grows them beyond their configured
        maximum, but still lets them hold their labels and loops like
        all others  */
    const chanW = chanCap.map((w, c) => need.chan.has(c) ? Math.max(need.chan.get(c)!, chanOf(c, 0)) : w)
    const gutH  = gutCap.map((h, g)  => need.gut.has(g)  ? Math.max(need.gut.get(g)!,  gutOf(g, 0))  : h)

    /*  derive the column and row center positions  */
    const colCX: number[] = []
    const rowCY: number[] = []
    let x = config["size-canvas-margin"]
    for (let c = 0; c < colWidth.length; c++) {
        colCX.push(x + colWidth[c] / 2)
        x += colWidth[c] + chanW[c]
    }
    let y = config["size-canvas-margin"]
    for (let r = 0; r < rowHeight.length; r++) {
        rowCY.push(y + rowHeight[r] / 2)
        y += rowHeight[r] + gutH[r]
    }
    const gutCY = rowCY.map((cy, g) => cy + rowHeight[g] / 2 + gutH[g] / 2)
    return { colWidth, rowHeight, chanCap, gutCap, chanW, gutH, colCX, rowCY, gutCY }
}

/*  pack the columns of the grid vertically: instead of centering every
    node in the band of its row, which is as high as the highest box of
    the row across all columns and leaves the sparsely occupied columns
    with large empty areas, every column stacks its nodes in their row
    order with just the spacing of an edge-less gutter in between. The
    rows survive only where something requires their alignment: the
    nodes linked by a direct same-row edge stay centered on one line
    (so the edge stays straight), and a gutter used by any edge track
    becomes a horizontal band merely across the lanes its tracks run
    through (the channels and the columns between their two channels),
    placed below everything of the rows above it in these lanes and
    above everything of the rows below it, and below the end nodes of
    its edges lying above it in the grid, while the end nodes lying
    below it in the grid pack freely in their own columns (so they may
    rise above it, their edges then turning up into them). All lanes
    outside a band ignore it, so a column crossed by no track of a
    gutter just packs through it. The positions follow from a single
    sweep over the rows and gutters in their grid order, as all these
    constraints point downwards only, followed by a reverse sweep
    letting the boxes, whose edges all lead downwards, sink back towards
    their neighbors within the room left (a box with self-loops reserves
    the room of their detours above itself, and the free room around
    every box becomes its vertical shift range for the node nudging)  */
const packColumns = (
    grid:   Grid,
    nodes:  Node[],
    edges:  Edge[],
    plans:  RoutePlan[],
    col:    Map<string, number>,
    row:    Map<string, number>,
    boxH:   Map<string, number>,
    nrows:  number,
    config: Config
): Grid => {
    const margin = config["size-canvas-margin"]
    const space  = Math.min(config["graph-gutter-height-max"],
        Math.max(config["graph-gutter-height-min"], GUT_H0))

    /*  the lanes: the column c is lane 2c, the channel right of it lane 2c+1  */
    const laneOf = (id: string) => 2 * col.get(id)!

    /*  group the nodes linked by direct same-row edges, as they share one center line  */
    const groupOf = new Map<string, string>()
    const find    = (id: string): string => {
        let root = id
        while (groupOf.has(root))
            root = groupOf.get(root)!
        return root
    }
    edges.forEach((edge, i) => {
        if (edge.source === edge.target || plans[i].chans.length !== 1 || plans[i].flags[0].hairpin
            || row.get(edge.source) !== row.get(edge.target))
            return
        const [ a, b ] = [ find(edge.source), find(edge.target) ]
        if (a !== b)
            groupOf.set(b, a)
    })
    const byRow = Array.from({ length: nrows }, () => new Map<string, Node[]>())
    for (const node of nodes)
        pushTo(byRow[row.get(node.id)!], find(node.id), node)

    /*  the room of the self-loop detours above every box  */
    const loopCnt = new Map<string, number>()
    for (const edge of edges)
        if (edge.source === edge.target)
            loopCnt.set(edge.source, (loopCnt.get(edge.source) ?? 0) + 1)
    const loopRoom = (id: string) => {
        const cnt = loopCnt.get(id) ?? 0
        return cnt > 0 ? LOOP_TOP + (cnt - 1) * config["size-edge-track-gap"] + GUT_PAD : 0
    }

    /*  the lane span of every used gutter (from the channel of one end to
        the channel of the other end, or up to the gate a gutter-ending
        edge ends at) and the end nodes of its edges  */
    const span = new Map<number, [ number, number ]>()
    const ends = new Map<number, string[]>()
    edges.forEach((edge, i) => {
        const { chans, guts, gate } = plans[i]
        if (guts.length === 0)
            return
        const g = guts[0]
        const a = gate === "s" ? laneOf(edge.source) : 2 * chans[0] + 1
        const b = gate === "t" ? laneOf(edge.target) : 2 * chans[1] + 1
        const [ lo, hi ] = span.get(g) ?? [ Infinity, -Infinity ]
        span.set(g, [ Math.min(lo, a, b), Math.max(hi, a, b) ])
        if (gate !== "s")
            pushTo(ends, g, edge.source)
        if (gate !== "t")
            pushTo(ends, g, edge.target)
    })

    /*  sweep the rows and gutters top-down, stacking every node right
        below the lowest bottom of its lane so far (with the spacing of an
        edge-less gutter below a box, and none below a band), and record
        the sequence of the boxes and bands of every lane  */
    const bottom = new Map<number, number>()
    const seq    = new Map<number, (string | number)[]>()
    const nodeCY = new Map<string, number>()
    const gutCY  = grid.gutCY.slice()
    const gutTop = (g: number) => gutCY[g] - grid.gutH[g] / 2
    const top    = (id: string) => nodeCY.get(id)! - boxH.get(id)! / 2 - loopRoom(id)
    const base   = (id: string) => nodeCY.get(id)! + boxH.get(id)! / 2
    const ceil   = new Map<string, number>()
    for (let r = 0; r < nrows; r++) {
        for (const members of byRow[r].values()) {
            /*  center the group on the lowest center line any member needs  */
            const cy = Math.max(...members.map((node) => {
                const lane = laneOf(node.id)
                const prev = seq.get(lane)?.at(-1)
                const free = prev === undefined ? margin : bottom.get(lane)! + (typeof prev === "string" ? space : 0)
                return free + loopRoom(node.id) + boxH.get(node.id)! / 2
            }))
            for (const node of members) {
                nodeCY.set(node.id, cy)
                bottom.set(laneOf(node.id), base(node.id))
                pushTo(seq, laneOf(node.id), node.id)
            }
        }

        /*  place the band of the gutter below the row, if used  */
        const lanes = span.get(r)
        if (lanes === undefined)
            continue
        const above = (ends.get(r) ?? []).filter((id) => row.get(id)! <= r)
        let y = margin
        for (let lane = lanes[0]; lane <= lanes[1]; lane++)
            y = Math.max(y, bottom.get(lane) ?? margin)
        for (const id of above)
            y = Math.max(y, base(id))
        gutCY[r] = y + grid.gutH[r] / 2
        for (let lane = lanes[0]; lane <= lanes[1]; lane++) {
            bottom.set(lane, y + grid.gutH[r])
            pushTo(seq, lane, r)
        }
        for (const id of above)
            ceil.set(id, Math.min(ceil.get(id) ?? Infinity, y))
    }
    const lowest = Math.max(margin, ...Array.from(bottom.values()))

    /*  the neighbors of a box in its lane: the box or band right above
        and right below it (if any)  */
    const prevOf = new Map<string, string | number>()
    const nextOf = new Map<string, string | number>()
    for (const items of seq.values())
        items.forEach((item, i) => {
            if (typeof item !== "string")
                return
            if (i > 0)
                prevOf.set(item, items[i - 1])
            if (i + 1 < items.length)
                nextOf.set(item, items[i + 1])
        })

    /*  sweep the rows bottom-up and let every box, which is linked to
        no box in its row by a direct edge and whose edges all lead to
        boxes below it, sink towards the nearest of them, as far as its
        lane leaves room (the box or band below it, already settled, and
        the bands it has to stay above), so the packing does not tear
        a box away from its edges where no gap is gained by it  */
    const adjacent = new Map<string, string[]>()
    for (const edge of edges) {
        if (edge.source === edge.target)
            continue
        pushTo(adjacent, edge.source, edge.target)
        pushTo(adjacent, edge.target, edge.source)
    }
    for (let r = nrows - 1; r >= 0; r--) {
        for (const members of byRow[r].values()) {
            const id = members[0].id
            const nb = adjacent.get(id) ?? []
            if (members.length > 1 || nb.length === 0 || nb.some((other) => nodeCY.get(other)! <= nodeCY.get(id)!))
                continue
            const next  = nextOf.get(id)
            const limit = Math.min(ceil.get(id) ?? Infinity,
                next === undefined ? lowest : typeof next === "string" ? top(next) - space : gutTop(next))
            const want  = Math.min(...nb.map((other) => nodeCY.get(other)!)) - nodeCY.get(id)!
            nodeCY.set(id, nodeCY.get(id)! + Math.max(0, Math.min(want, limit - base(id))))
        }
    }

    /*  the vertical shift range of every box for the node nudging: the
        free room up to the band above and down to the band below it,
        and half the free room to the box above and below it (shared
        with that box), with the spacing between them kept  */
    const room = new Map<string, [ number, number ]>()
    for (const node of nodes) {
        const [ prev, next ] = [ prevOf.get(node.id), nextOf.get(node.id) ]
        const up   = prev === undefined ? top(node.id) - margin :
            typeof prev === "string" ? (top(node.id) - base(prev) - space) / 2 :
                top(node.id) - gutTop(prev) - grid.gutH[prev]
        const down = next === undefined ? lowest - base(node.id) :
            typeof next === "string" ? (top(next) - base(node.id) - space) / 2 :
                gutTop(next) - base(node.id)
        room.set(node.id, [ -Math.max(0, up), Math.max(0, down) ])
    }
    return { ...grid, gutCY, nodeCY, room }
}

/*  the bundle keys of an edge: the target key collects the edges of the
    same name leading to the same target node side with the same arity
    (directly from the channel the key belongs to, or else through the
    given gutter), the source key the edges of the same name coming from
    the same source node side (directly into the channel, or else
    through the given gutter)  */
const targetKey = (c: number, edge: Edge, via?: number): string =>
    `t:${c}:${via ?? ""}:${JSON.stringify([ edge.target, edge.arity ?? null, edge.name ?? null ])}`
const sourceKey = (c: number, edge: Edge, via?: number): string =>
    `s:${c}:${via ?? ""}:${JSON.stringify([ edge.source, edge.name ?? null ])}`

/*  the merged edge ends: the key of the bundle whose edges run into
    their target node, or out of their source node, as one, merging
    their edge ends at that node into one port  */
type Merge = (edge: number, role: "s" | "t") => string | undefined

/*  assign the parallel tracks within the channels and gutters and derive
    the resulting track coordinate functions (see assignTracks for the
    crossing-avoiding ordering scheme, with backward edges entering the
    channel mirrored from the right side; the gutters use the very same
    scheme, just transposed: edges dropping in from above enter from the
    near side, edges rising from below are the mirrored users), together
    with the needs of the crowded channels and gutters and the edges
    bundled within the channels (with the key of their bundle, by the
    channel and the edge)  */
const assignTrackCoords = (
    edges:   Edge[],
    plans:   RoutePlan[],
    portPos: Map<string, { x: number, y: number }>,
    grid:    Grid,
    config:  Config,
    merged?: Merge
): { chanX: (c: number, edge: number) => number, gutY: (g: number, edge: number) => number,
    need: Need, bundled: Set<number>, keys: Map<string, string> } => {
    const { colWidth, chanCap, gutCap, chanW, colCX } = grid
    const gutBase = (g: number) => grid.gutCY[g]
    const gap     = config["size-edge-track-gap"]
    const gapMin  = config["size-edge-track-gap-min"]
    const need: Need = { chan: new Map<number, number>(), gut: new Map<number, number>() }
    const bundled    = new Set<number>()
    const keys       = new Map<string, string>()

    /*  assign the vertical tracks within the inter-column channels (the
        leg of a self-loop spans up to its detour above the box, and a
        gutter-ending edge takes no track in its gate-side channel). In a
        crowded channel, the edges leading to the same target node side
        (directly, or through the same gutter) are bundled, or else the
        ones coming from the same source node side, but never the
        self-loops, as their detours would coincide, and the edges whose
        ends were merged into one port stay bound to their bundle in the
        channel beside that port  */
    const chanUsers = new Map<number, TrackUser[]>()
    edges.forEach((edge, i) => {
        const { chans, guts, flags, gate } = plans[i]
        const sp   = portPos.get(`${i}:s`)!
        const tp   = portPos.get(`${i}:t`)!
        const tEnd = merged?.(i, "t")
        const sEnd = merged?.(i, "s")
        if (edge.source === edge.target)
            pushTo(chanUsers, chans[0], { edge: i, posIn: sp.y, posOut: tp.y - LOOP_TOP, ...flags[0] })
        else if (chans.length === 1)
            pushTo(chanUsers, chans[0], { edge: i, posIn: sp.y, posOut: tp.y, ...flags[0],
                bundles: [ targetKey(chans[0], edge), sourceKey(chans[0], edge) ], unit: tEnd ?? sEnd })
        else {
            const gy = gutBase(guts[0])
            if (gate !== "s")
                pushTo(chanUsers, chans[0], { edge: i, posIn: sp.y, posOut: gy,   ...flags[0],
                    bundles: [ targetKey(chans[1], edge, guts[0]), sourceKey(chans[0], edge) ], unit: sEnd })
            if (gate !== "t")
                pushTo(chanUsers, chans[1], { edge: i, posIn: gy,   posOut: tp.y, ...flags[1],
                    bundles: [ targetKey(chans[1], edge), sourceKey(chans[0], edge, guts[0]) ], unit: tEnd })
        }
    })
    /*  the unique numeric key of an edge within a channel or gutter  */
    const keyOf   = (c: number, edge: number) => c * edges.length + edge
    const chanOff = new Map<number, number>()
    const shift   = new Map<number, number>()
    const frame   = Math.max(CHAN_W1, 2 * arrowRoom(config))
    for (const [ c, users ] of chanUsers) {
        /*  a channel holding a bundle which runs into (or out of) its
            node through one merged port keeps that run long enough for
            the labels of the bundle placed there  */
        const reach  = users.reduce((max, u) =>
            u.unit !== undefined ? Math.max(max, 2 * stubRoom(edges[u.edge], config)) : max, frame)
        const tracks = assignTracks(users, chanCap[c], CHAN_PAD, gap, gapMin, reach)
        for (const [ edge, off ] of tracks.offsets)
            chanOff.set(keyOf(c, edge), off)
        if (tracks.need > 0)
            need.chan.set(c, tracks.need)
        for (const [ edge, key ] of tracks.bundled) {
            bundled.add(edge)
            keys.set(`${c}:${edge}`, key)
        }

        /*  keep the stubs of the edges arriving at the nodes beside the
            channel long enough for their name and arity labels placed
            there, side by side in front of the arrow head, by shifting
            the tracks away from the side lacking that room, as far as
            the other side keeps its own room (or, if both sides lack it,
            as the channel is capped by its configured maximum, by
            splitting the lack between them, but never by pushing a track
            out of the arrow room of either side, i.e., into the boxes
            beside the channel), where the stubs of a bundle
            running out of its node through one merged port keep the room
            of its name label placed there, too, but the bundled edges
            not merged into one port are exempt, as their names are
            placed on the stubs feeding their shared track  */
        const room: [ number, number ] = [ arrowRoom(config), arrowRoom(config) ]
        for (const u of users) {
            const edge    = edges[u.edge]
            const arrival = arrivalOf(edge, plans[u.edge])
            if (edge.name === undefined)
                continue
            if (arrival?.chan === c && (!tracks.bundled.has(u.edge) || merged?.(u.edge, "t") !== undefined))
                room[arrival.right ? 1 : 0] = Math.max(room[arrival.right ? 1 : 0], stubRoom(edge, config))
            if (plans[u.edge].chans[0] === c && merged?.(u.edge, "s") !== undefined)
                room[plans[u.edge].flags[0].mirror ? 1 : 0] =
                    Math.max(room[plans[u.edge].flags[0].mirror ? 1 : 0], stubRoom(edge, config))
        }
        const offs = users.map((u) => tracks.offsets.get(u.edge)!)
        const lo   = room[0] - chanW[c] / 2 - Math.min(...offs)
        const hi   = chanW[c] / 2 - room[1] - Math.max(...offs)
        const min  = arrowRoom(config) - chanW[c] / 2 - Math.min(...offs)
        const max  = chanW[c] / 2 - arrowRoom(config) - Math.max(...offs)
        shift.set(c, lo <= hi ? Math.min(Math.max(0, lo), hi) :
            min <= max ? Math.min(Math.max((lo + hi) / 2, min), max) : (min + max) / 2)
    }
    const chanX = (c: number, edge: number) => colCX[c] + colWidth[c] / 2 + chanW[c] / 2 +
        shift.get(c)! + chanOff.get(keyOf(c, edge))!

    /*  assign the horizontal tracks within the inter-row gutters (the
        run of a gutter-ending edge extends up to its gate, where its
        stub continues straight and hence crosses no other track)  */
    const gutUsers = new Map<number, TrackUser[]>()
    edges.forEach((edge, i) => {
        const { chans, guts, gate } = plans[i]
        if (guts.length === 0)
            return
        const sp = portPos.get(`${i}:s`)!
        const tp = portPos.get(`${i}:t`)!
        pushTo(gutUsers, guts[0], {
            edge:    i,
            posIn:   gate === "s" ? sp.x : chanX(chans[0], i),
            posOut:  gate === "t" ? tp.x : chanX(chans[1], i),
            mirror:  sp.y > gutBase(guts[0]),
            bundles: [ targetKey(chans[1], edge), sourceKey(chans[0], edge) ]
        })
    })
    const gutOff = new Map<number, number>()
    for (const [ g, users ] of gutUsers) {
        const tracks = assignTracks(users, gutCap[g], GUT_PAD, gap, gapMin, GUT_H1)
        for (const [ edge, off ] of tracks.offsets)
            gutOff.set(keyOf(g, edge), off)
        if (tracks.need > 0)
            need.gut.set(g, tracks.need)
        for (const edge of tracks.bundled.keys())
            bundled.add(edge)
    }
    const gutY = (g: number, edge: number) => gutBase(g) + gutOff.get(keyOf(g, edge))!
    return { chanX, gutY, need, bundled, keys }
}

/*  route every edge as an orthogonal polyline through the channels
    between columns and the gutters between rows  */
const routePolys = (
    edges:   Edge[],
    plans:   RoutePlan[],
    portPos: Map<string, { x: number, y: number }>,
    boxH:    Map<string, number>,
    cy:      (id: string) => number,
    chanX:   (c: number, edge: number) => number,
    gutY:    (g: number, edge: number) => number
): Poly[] => {
    /*  the innermost channel track among the self-loops of each node  */
    const loopX = new Map<string, number>()
    edges.forEach((edge, i) => {
        if (edge.source === edge.target)
            loopX.set(edge.source, Math.min(loopX.get(edge.source) ?? Infinity, chanX(plans[i].chans[0], i)))
    })
    return edges.map((edge, i) => {
        const sp = portPos.get(`${i}:s`)!
        const tp = portPos.get(`${i}:t`)!
        const { chans, guts, flags, gate } = plans[i]
        let pts: Poly
        if (edge.source === edge.target) {
            /*  route the self-loop counter-clockwise around the top-right
                box corner: out on the east side, up along its channel
                track, back left above the box, and down into the north
                side again (the detour above the box is the wider one, as
                its final descent has to stay readable behind the arrow
                head, and grows with the track distance from the innermost
                loop of the node, so the nested loops stay apart)  */
            const ox  = chanX(chans[0], i)
            const oy  = cy(edge.source) - boxH.get(edge.source)! / 2 - LOOP_TOP - (ox - loopX.get(edge.source)!)
            pts = [ [ sp.x, sp.y ], [ ox, sp.y ], [ ox, oy ], [ tp.x, oy ], [ tp.x, tp.y ] ]
        }
        else if (chans.length === 1) {
            const ch = chanX(chans[0], i)
            if (!flags[0].hairpin && sp.y === tp.y)
                pts = [ [ sp.x, sp.y ], [ tp.x, tp.y ] ]
            else
                pts = [ [ sp.x, sp.y ], [ ch, sp.y ], [ ch, tp.y ], [ tp.x, tp.y ] ]
        }
        else {
            /*  a gutter-ending edge leaves the gutter straight into its
                gate instead of turning into the gate-side channel  */
            const ch1 = chanX(chans[0], i)
            const ch2 = chanX(chans[1], i)
            const gy  = gutY(guts[0], i)
            if (gate === "t")
                pts = [ [ sp.x, sp.y ], [ ch1, sp.y ], [ ch1, gy ], [ tp.x, gy ] ]
            else if (gate === "s")
                pts = [ [ sp.x, gy ], [ ch2, gy ], [ ch2, tp.y ], [ tp.x, tp.y ] ]
            else
                pts = [ [ sp.x, sp.y ], [ ch1, sp.y ], [ ch1, gy ], [ ch2, gy ], [ ch2, tp.y ], [ tp.x, tp.y ] ]
        }
        return simplifyPoly(pts)
    })
}

/*  the routing of all edges: the attachment ports, the gutter track
    positions, the polylines, the needs of the crowded channels and
    gutters (and whether the grid fulfills them), the edges bundled
    within them (with the keys of their bundles in the channels, see
    assignTrackCoords), and the number of crossings between them
    (determined on demand only, as merely the node nudging needs it)  */
interface Routing {
    portPos: Map<string, { x: number, y: number }>
    gutY:    (g: number, edge: number) => number
    polys:   Poly[]
    need:    Need
    fits:    boolean
    bundled: Set<number>
    keys:    Map<string, string>
    hops:    () => number
}

/*  route every edge for the given node positions: distribute the
    attachment ports along each node side and assign the parallel tracks
    within the channels and gutters, provisionally, to learn the gutter
    track every edge follows, then re-distribute the ports with every
    gutter-routed edge ordered by its actual gutter track approach
    instead of the opposite node position (which can disagree and would
    cross the edges right in front of their attachments), re-assign the
    tracks on top of the moved ports and finally route every edge as an
    orthogonal polyline through the channels between the columns and
    the gutters between the rows  */
const routeEdges = (
    edges:   Edge[],
    plans:   RoutePlan[],
    sides:   { s: Side, t: Side }[],
    boxW:    Map<string, number>,
    boxH:    Map<string, number>,
    cx:      (id: string) => number,
    cy:      (id: string) => number,
    grid:    Grid,
    config:  Config,
    level:   LevelContext,
    merged?: Merge
): Routing => {
    const portGap  = portGapOf(edges, config, merged)
    const portPre  = assignPorts(edges, sides, cx, cy, boxW, boxH, portGap,
        undefined, level.fixedPort, merged)
    const trackPre = assignTrackCoords(edges, plans, portPre, grid, config, merged)
    const portPos  = assignPorts(edges, sides, cx, cy, boxW, boxH, portGap,
        (edge) => plans[edge].guts.length > 0 ?
            trackPre.gutY(plans[edge].guts[0], edge) : undefined, level.fixedPort, merged)
    const { chanX, gutY, need, bundled, keys } = assignTrackCoords(edges, plans, portPos, grid, config, merged)
    const polys = routePolys(edges, plans, portPos, boxH, cy, chanX, gutY)
    const fits  = Array.from(need.chan).every(([ c, w ]) => w <= grid.chanW[c])
        && Array.from(need.gut).every(([ g, h ]) => h <= grid.gutH[g])
    let   count: number | undefined
    const hops  = (): number => {
        count ??= computeHops(polys).reduce((sum, segs) =>
            sum + Array.from(segs.values()).reduce((n, xs) => n + xs.length, 0), 0)
        return count
    }
    return { portPos, gutY, polys, need, fits, bundled, keys, hops }
}

/*  nudge nodes vertically off their row centers to straighten the
    direct edges to their same-row neighbors in the adjacent columns, as
    far as this improves the overall routing (fewer crossings, or as many
    crossings but fewer jogged direct edges): a node may leave its row
    band into an adjacent gutter only as far as no gutter track runs
    across its column and no self-loop detours through it there (a loop
    rises above the box of its node), and only as long as its own
    gutter-routed edges keep approaching it from their gutter side and
    the tracks of the crowded channels and gutters keep fitting in  */
const nudgeNodes = (
    nodes:  Node[],
    edges:  Edge[],
    plans:  RoutePlan[],
    col:    Map<string, number>,
    row:    Map<string, number>,
    boxH:   Map<string, number>,
    grid:   Grid,
    nrows:  number,
    dy:     Map<string, number>,
    route:  () => Routing,
    first:  Routing
): Routing => {
    /*  whether neither a gutter track nor a self-loop detour crosses a column within a gutter  */
    const gutterFree = (g: number, c: number): boolean =>
        !plans.some((plan) => plan.guts[0] === g
            && Math.min(...plan.chans) < c
            && c <= Math.max(...plan.chans) + (plan.gate === "t" ? 1 : 0))
        && !edges.some((edge) => edge.source === edge.target
            && row.get(edge.source) === g + 1 && col.get(edge.source) === c)

    /*  the vertical shift range of a node: its row slack plus the room
        of its free adjacent gutters (or, in a grid with packed columns,
        its share of the free room around it in its column)  */
    const shiftRange = (id: string): [ number, number ] => {
        if (grid.room !== undefined)
            return grid.room.get(id)!
        const r     = row.get(id)!
        const c     = col.get(id)!
        const slack = (grid.rowHeight[r] - boxH.get(id)!) / 2
        const up    = r > 0         && gutterFree(r - 1, c) ? grid.gutH[r - 1] - GUT_H0 : 0
        const down  = r < nrows - 1 && gutterFree(r, c)     ? grid.gutH[r]     - GUT_H0 : 0
        return [ -(slack + up), slack + down ]
    }

    /*  whether the gutter-routed edges of a node still approach it from
        their gutter side (in a grid with packed columns the side it lies
        on, else the side of its row)  */
    const below = (id: string, g: number): boolean =>
        grid.nodeCY !== undefined ? grid.nodeCY.get(id)! > grid.gutCY[g] : row.get(id)! > g
    const approachesSanely = (id: string, routing: Routing): boolean =>
        edges.every((edge, i) => {
            const role = edge.source === id ? "s" : edge.target === id ? "t" : null
            if (role === null || plans[i].guts.length === 0)
                return true
            const g   = plans[i].guts[0]
            const gap = routing.portPos.get(`${i}:${role}`)!.y - routing.gutY(g, i)
            return below(id, g) ? gap >= NUDGE_GAP : gap <= -NUDGE_GAP
        })

    /*  rank the routings: fewer crossings first, then fewer jogged direct same-row edges  */
    const direct = edges.map((edge, i) => plans[i].chans.length === 1
        && !plans[i].flags[0].hairpin
        && row.get(edge.source) === row.get(edge.target))
    const jogs = (routing: Routing): number =>
        edges.filter((_, i) => direct[i]
            && routing.portPos.get(`${i}:s`)!.y !== routing.portPos.get(`${i}:t`)!.y).length
    const better = (a: Routing, b: Routing): boolean =>
        a.hops() < b.hops() || (a.hops() === b.hops() && jogs(a) < jogs(b))

    /*  try, in a few passes, for every node the shifts aligning one of
        its direct edges, and keep the best of the shifts improving the
        routing (all shifts are relative to the current position, which
        already includes the shifts of the previous passes)  */
    let current = first

    /*  skip the nudging on large graphs, as every tried shift re-routes
        all edges, so its effort grows with the node count times the
        edge count, while it only straightens a few direct edges  */
    if (edges.length > NUDGE_EDGES)
        return current
    for (let pass = 0; pass < NUDGE_PASSES; pass++) {
        let changed = false
        for (const node of nodes) {
            const [ lo, hi ] = shiftRange(node.id)
            const shifts = new Set<number>()
            edges.forEach((edge, i) => {
                if (!direct[i])
                    return
                const sp = current.portPos.get(`${i}:s`)!
                const tp = current.portPos.get(`${i}:t`)!
                if (edge.source === node.id)
                    shifts.add(tp.y - sp.y)
                else if (edge.target === node.id)
                    shifts.add(sp.y - tp.y)
            })
            const base = dy.get(node.id) ?? 0
            let best: { shift: number, routing: Routing } | undefined
            for (const shift of shifts) {
                if (shift === 0 || base + shift < lo || base + shift > hi)
                    continue
                dy.set(node.id, base + shift)
                const routing = route()
                if (approachesSanely(node.id, routing) && routing.fits
                    && better(routing, best?.routing ?? current))
                    best = { shift: base + shift, routing }
            }
            dy.set(node.id, best?.shift ?? base)
            if (best !== undefined) {
                current = best.routing
                changed = true
            }
        }
        if (!changed)
            break
    }
    return current
}

/*  determine the attachment sides of every edge, derived from the
    column relation of its endpoint nodes (a self-loop leaves on the
    east side and re-enters on the north side of its own box), except
    for an edge end attaching at a fixed port of a container box,
    which always uses the side of the inner gate: the west side
    when entering the container, the east side when leaving it  */
const attachSides = (
    edges: Edge[],
    col:   Map<string, number>,
    level: LevelContext
): { s: Side, t: Side }[] =>
    edges.map((edge, i) => {
        const sc = col.get(edge.source)!
        const tc = col.get(edge.target)!
        if (edge.source === edge.target)
            return { s: "e", t: "n" }
        const s: Side = level.fixedPort?.(i, "s") !== undefined ? "e" : sc <= tc ? "e" : "w"
        const t: Side = level.fixedPort?.(i, "t") !== undefined ? "w" : sc <  tc ? "w" : "e"
        return { s, t }
    })

/*  grow every box up to the height hosting all of its edge
    attachments at the full port separation, and the one whose
    attachments exceed the configured per-side maximum additionally
    step-wise by one separation per additional edge, so the ports of a
    node never pack tighter than configured, however small its content
    height is (the fixed-size boxes of a containment level are exempt)  */
const growBoxes = (
    nodes:   Node[],
    edges:   Edge[],
    sides:   { s: Side, t: Side }[],
    boxH:    Map<string, number>,
    config:  Config,
    level:   LevelContext,
    merged?: Merge
): void => {
    const portGap = portGapOf(edges, config, merged)
    const portCnt = new Map<string, number>()
    edges.forEach((edge, i) => {
        portCnt.set(`${sides[i].s}:${edge.source}`, (portCnt.get(`${sides[i].s}:${edge.source}`) ?? 0) + 1)
        portCnt.set(`${sides[i].t}:${edge.target}`, (portCnt.get(`${sides[i].t}:${edge.target}`) ?? 0) + 1)
    })

    /*  count the edge ends merged into one port as one  */
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
        const extra = Math.max(0, cnt - config["graph-node-degree-max"])
        boxH.set(node.id, Math.max(
            boxH.get(node.id)! + extra * portGap(node.id), cnt * portGap(node.id) + PORT_PAD))
    }
}

/*  lay out a directed graph model (for a containment level: with the
    container placeholders at their fixed sizes, the edge ends attaching
    to them at their fixed ports, and the gate nodes on the boundary)  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    const nodes = Array.from(graph.nodes.values())
    const edges = graph.edges

    /*  the gate nodes are kept out of the layered layout and the grid
        refinement, as they are placed into their own columns afterwards  */
    const gates     = level.gates ?? new Map<string, GateSide>()
    const real      = nodes.filter((node) => !gates.has(node.id))
    const realEdges = edges.filter((edge) => !gates.has(edge.source) && !gates.has(edge.target))

    /*  determine node box sizes from their textual content
        (all boxes at half height scale, grown by their edge
        attachment needs once the attachment sides are known)  */
    const { boxW, boxH, contentH } = measureNodes(nodes, config,
        () => config["size-node-height-scale"] / 2, level.fixedSize)

    const maxCols = Math.max(Math.floor(config["graph-columns-max"]), 1)
    const col     = new Map<string, number>()
    const row     = new Map<string, number>()
    let   ncols: number
    let   nrows: number
    const ordered = real.some((node) => orderOf(node) !== undefined)

    /*  only the layered layout packs its columns (see packColumns), as
        the rows of an explicitly ordered graph carry a meaning of their
        own  */
    const packed  = !ordered
    if (ordered) {
        /*  an explicitly ordered graph (at least one node carrying an
            "order" attribute) bypasses the layered layout: the distinct
            order values become the rows, top-down in ascending order,
            the nodes of one value fill their row left-to-right in
            declaration order (wrapped into further rows beyond the
            configured maximum of side-by-side nodes), and the nodes
            without an order follow in the trailing rows  */
        const byValue = new Map<number, Node[]>()
        for (const node of real)
            pushTo(byValue, orderOf(node) ?? Infinity, node)
        const values  = Array.from(byValue.keys()).sort((a, b) => a - b)
        ncols = 1
        nrows = 0
        for (const value of values) {
            const members = byValue.get(value)!
            members.forEach((node, i) => {
                col.set(node.id, i % maxCols)
                row.set(node.id, nrows + Math.floor(i / maxCols))
            })
            ncols  = Math.max(ncols, Math.min(members.length, maxCols))
            nrows += Math.ceil(members.length / maxCols)
        }
    }
    else {
        /*  determine raw node positions with the AntV Dagre layout, for
            the nodes connected by an edge only, as the edge-less nodes
            are bound by no ordering constraint at all and Dagre would
            merely stack them into its first rank, too, where the row
            compaction lifts them into the topmost free cells anyway
            (or, for packed columns, keeps them below all connected
            nodes)  */
        const rawX   = new Map<string, number>()
        const rawY   = new Map<string, number>()
        const linked = new Set<string>()
        for (const edge of realEdges) {
            linked.add(edge.source)
            linked.add(edge.target)
        }
        const connected = real.filter((node) =>  linked.has(node.id))
        const isolated  = real.filter((node) => !linked.has(node.id))
        if (connected.length > 0) {
            const layout = new DagreLayout({
                rankdir:  "LR",
                nodesep:  config["graph-node-separation"],
                ranksep:  config["graph-rank-separation"],
                nodeSize: (node) => (node as { size: [ number, number ] }).size
            })
            await layout.execute({
                nodes: connected.map((node) => ({ id: node.id, size: [ boxW.get(node.id)!, boxH.get(node.id)! ] })),
                edges: realEdges.map((edge, i) => ({ id: `e${i}`, source: edge.source, target: edge.target }))
            })
            layout.forEachNode((node) => {
                rawX.set(String(node.id), node.x)
                rawY.set(String(node.id), node.y)
            })
        }

        /*  stack the edge-less nodes, in declaration order, into the
            first rank below all connected nodes, each into a row of its
            own (more than the row clustering threshold apart)  */
        const firstX = connected.reduce((x, node) => Math.min(x, rawX.get(node.id)!), Infinity)
        const lastY  = connected.reduce((y, node) => Math.max(y, rawY.get(node.id)!), -Infinity)
        isolated.forEach((node, i) => {
            rawX.set(node.id, Number.isFinite(firstX) ? firstX : 0)
            rawY.set(node.id, (Number.isFinite(lastY) ? lastY : 0) + (i + 1) * (CLUSTY + 1))
        })

        /*  snap the raw positions onto the discrete column/row grid  */
        const snapped = snapToGrid(real, rawX, rawY)
        for (const [ id, c ] of snapped.col)
            col.set(id, c)
        for (const [ id, r ] of snapped.row)
            row.set(id, r)

        /*  refine the row assignment by pulling every node vertically
            toward the median row of its direct neighbors  */
        refineRows(real, realEdges, col, row)

        /*  fold the grid columns: constrain the diagram width to at most
            the configured maximum of side-by-side nodes by wrapping excess
            columns into additional row bands below, so wide graphs grow in
            height (where, for packed columns, the edge-less nodes move
            into the last band, so they stay below all connected nodes)  */
        if (snapped.ncols > maxCols) {
            const last = Math.floor((snapped.ncols - 1) / maxCols)
            for (const node of real) {
                const c    = col.get(node.id)!
                const band = packed && !linked.has(node.id) ? last : Math.floor(c / maxCols)
                col.set(node.id, c % maxCols)
                row.set(node.id, row.get(node.id)! + band * snapped.nrows)
            }
        }

        /*  compact the sparsely occupied grid rows into fewer, denser ones  */
        ncols = Math.min(snapped.ncols, maxCols)
        nrows = compactRows(real, realEdges, col, row, !packed)
    }

    /*  in a single-column layout, widen the container placeholders to
        the widest one, so the stacked container boxes line up (their
        content stays centered and their height the one of their content)  */
    if (ncols === 1) {
        const fixed = real.filter((node) => level.fixedSize?.has(node.id))
        const width = fixed.reduce((a, node) => Math.max(a, boxW.get(node.id)!), 0)
        for (const node of fixed)
            boxW.set(node.id, width)
    }

    /*  place the gate nodes into their own boundary columns  */
    ({ ncols, nrows } = placeGates(gates, edges, col, row, ncols, nrows))

    /*  determine the attachment sides of every edge  */
    const sides = attachSides(edges, col, level)

    /*  plan the coarse channel/gutter route of every edge (a west side
        attachment in the first column needs a channel left of it, so
        the whole grid is shifted one column to the right then)  */
    let routes = planRoutes(edges, col, row, sides, gates, config)
    if (routes.plans.some((plan) => plan.chans.some((c) => c < 0))) {
        for (const node of nodes)
            col.set(node.id, col.get(node.id)! + 1)
        ncols++
        routes = planRoutes(edges, col, row, sides, gates, config)
    }
    const { plans, chanCnt, gutCnt, chanLbl, gutLbl, gutLoop } = routes

    /*  grow the boxes by their edge attachment needs (anew from their
        content sizes, once the edge ends merged into one port are known)  */
    const sizedH = new Map(boxH)
    const sizeBoxes = (merged?: Merge) => {
        for (const [ id, h ] of sizedH)
            boxH.set(id, h)
        growBoxes(nodes, edges, sides, boxH, config, level, merged)
    }
    sizeBoxes()

    /*  determine grid cell sizes and node center positions (the nodes
        centered in their rows, or stacked in their packed columns, before
        any vertical nudging)  */
    const need: Need = { chan: new Map<number, number>(), gut: new Map<number, number>() }
    const layoutGrid = () => {
        const grid = computeGrid(nodes, col, row, boxW, boxH, ncols, nrows,
            chanCnt, gutCnt, chanLbl, gutLbl, gutLoop, need, config)
        return packed ? packColumns(grid, nodes, edges, plans, col, row, boxH, nrows, config) : grid
    }
    let   grid = layoutGrid()
    const dy   = new Map<string, number>()
    const cx   = (id: string) => grid.colCX[col.get(id)!]
    const cy   = (id: string) => (grid.nodeCY?.get(id) ?? grid.rowCY[row.get(id)!]) + (dy.get(id) ?? 0)

    /*  route the edges for the current node positions (with the edge
        ends merged into one port, once determined)  */
    let   merged: Merge | undefined
    const route = () => routeEdges(edges, plans, sides, boxW, boxH, cx, cy, grid, config, level, merged)

    /*  lay out the grid and route the edges: size the crowded channels
        and gutters by the needs of their bundled tracks and route the
        edges anew, until the needs settle (as the resized gutters shift
        the rows, and with them the spans of the channel tracks, in a few
        passes, which only grow the channels and gutters further, so they
        surely settle), and finally nudge nodes vertically off their row
        centers where this straightens edges and thereby simplifies the
        routing  */
    const layout = (): Routing => {
        need.chan.clear()
        need.gut.clear()
        dy.clear()
        grid = layoutGrid()
        let initial = route()
        for (let pass = 0; pass < GROW_PASSES; pass++) {
            let changed = false
            const settle = (to: Map<number, number>, from: Map<number, number>) => {
                for (const [ k, v ] of from) {
                    const size = pass === 0 ? v : Math.max(to.get(k) ?? 0, v)
                    if (size !== to.get(k)) {
                        to.set(k, size)
                        changed = true
                    }
                }
            }
            settle(need.chan, initial.need.chan)
            settle(need.gut,  initial.need.gut)
            if (!changed)
                break
            grid    = layoutGrid()
            initial = route()
        }
        return nudgeNodes(nodes, edges, plans, col, row, boxH, grid, nrows, dy, route, initial)
    }
    let routing = layout()

    /*  let the bundles (of edges of the same name) leading to the same
        target node side with the same arity run into it as one, and the
        bundles coming from the same source node side run out of it as
        one: merge the edge ends
        of every such bundle (bound in the channel beside the node, and
        not attaching at a fixed port or a gate) into one port, which
        frees the ports of the others, so the boxes are sized and the
        edges are laid out anew  */
    const ends  = new Map<string, string>()
    const count = new Map<string, number>()
    const bind  = (end: string, key: string) => {
        ends.set(end, key)
        count.set(key, (count.get(key) ?? 0) + 1)
    }
    edges.forEach((edge, i) => {
        const { chans, gate } = plans[i]
        if (edge.source === edge.target)
            return
        const tc = chans[chans.length - 1]
        const sc = chans[0]
        const tk = routing.keys.get(`${tc}:${i}`)
        const sk = routing.keys.get(`${sc}:${i}`)
        if (gate !== "t" && level.fixedPort?.(i, "t") === undefined && tk === targetKey(tc, edge))
            bind(`${i}:t`, tk)
        if (gate !== "s" && level.fixedPort?.(i, "s") === undefined && sk === sourceKey(sc, edge))
            bind(`${i}:s`, sk)
    })
    for (const [ end, key ] of ends)
        if (count.get(key)! < 2)
            ends.delete(end)
    if (ends.size > 0) {
        merged = (edge, role) => ends.get(`${edge}:${role}`)
        sizeBoxes(merged)
        routing = layout()
    }

    /*  mark the junctions of the bundled edges and whether any channel
        or gutter is crowded  */
    const junctions = junctionsOf(Array.from(routing.bundled, (i) => routing.polys[i]))
    const crowded   = routing.need.chan.size > 0 || routing.need.gut.size > 0

    /*  hand over the laid out graph for SVG rendering  */
    return { nodes, edges, cx, cy, boxW, boxH, contentH, polys: routing.polys,
        bundled: edges.map((_, i) => routing.bundled.has(i)), junctions, crowded }
}
