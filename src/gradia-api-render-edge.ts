/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Edge }             from "./gradia-api-model.js"
import { Config }           from "./gradia-api-config.js"
import { Poly, ARITY_PAD, ARROW_H, arityHeight }
    from "./gradia-api-render-base.js"

/*  edge attachment port geometry  */
export const PORT_PAD = 10  /*  padding of the port band inside the box  */

/*  the separation of the adjacent ports of a node side: the configured
    one, raised to what the arity labels demand once any edge carries
    one, as such a label sits ARITY_PAD below the line of the port above
    it, whose arrow head reaches down by half its height, and needs two
    more ARITY_PAD of air between the two, so it stays attributable to
    its own arrow instead of drifting into the neighboring one  */
export const portGapOf = (edges: Edge[], config: Config): number =>
    edges.some((edge) => edge.arity !== undefined) ?
        Math.max(config["size-edge-port-gap"],
            Math.ceil(3 * ARITY_PAD + arityHeight(config) + ARROW_H / 2)) :
        config["size-edge-port-gap"]

/*  drop duplicate and collinear intermediate points of a polyline  */
export const simplifyPoly = (pts: Poly): Poly => {
    /*  drop the collinear intermediate points first, as collapsing
        a backtracking triple leaves a duplicate point pair behind  */
    const flat: Poly = [ ...pts ]
    for (let k = flat.length - 2; k > 0; k--) {
        const [ a, b, c ] = [ flat[k - 1], flat[k], flat[k + 1] ]
        if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]))
            flat.splice(k, 1)
    }

    /*  drop the remaining duplicate points  */
    const out: Poly = []
    for (const p of flat) {
        const q = out.at(-1)
        if (q !== undefined && q[0] === p[0] && q[1] === p[1])
            continue
        out.push(p)
    }
    return out
}

/*  the node side an edge attaches to (east, west, or north, the
    latter carrying the incoming ends of the self-loops only)  */
export type Side = "e" | "w" | "n"

/*  an edge endpoint (the source or the target of an edge) attaching
    to a node side  */
interface PortRef {
    edge: number
    role: "s" | "t"
}

/*  distribute the edge attachment ports along each node side, ordered
    by the vertical position the edge approaches from (the approachY
    override where given, the opposite endpoint center otherwise) and
    separated by at most portGap (less, if the node box is too small
    to hold them all). A port with a fixed vertical offset from the
    box center (fixedY, the edge ends attaching to a container box at
    the position of the inner gate node) is placed exactly there and
    the distributed ports of the same side are dealt into the gaps
    around it  */
export const assignPorts = (
    edges:      Edge[],
    sides:      { s: Side, t: Side }[],
    cx:         (id: string) => number,
    cy:         (id: string) => number,
    boxW:       Map<string, number>,
    boxH:       Map<string, number>,
    portGap:    number,
    approachY?: (edge: number) => number | undefined,
    fixedY?:    (edge: number, role: "s" | "t") => number | undefined
): Map<string, { x: number, y: number }> => {
    /*  group the edge endpoints by the node side they attach to  */
    const portGroups = new Map<string, PortRef[]>()
    const addPort    = (key: string, edge: number, role: "s" | "t") => {
        const group = portGroups.get(key)
        if (group === undefined)
            portGroups.set(key, [ { edge, role } ])
        else
            group.push({ edge, role })
    }
    edges.forEach((edge, i) => {
        addPort(`${edge.source}:${sides[i].s}`, i, "s")
        addPort(`${edge.target}:${sides[i].t}`, i, "t")
    })

    /*  place the ports of each group, ordered by the opposite endpoint  */
    const portPos = new Map<string, { x: number, y: number }>()
    for (const [ key, group ] of portGroups) {
        const sep     = key.lastIndexOf(":")  /*  ids may contain a colon themselves  */
        const id      = key.slice(0, sep)
        const side    = key.slice(sep + 1)

        /*  spread the north side ports along the top side, in reverse
            edge order, so the innermost of the nested self-loops
            attaches closest to the top-right box corner  */
        if (side === "n") {
            group.sort((a, b) => b.edge - a.edge)
            const spacing = Math.min(portGap, (boxW.get(id)! - PORT_PAD) / group.length)
            group.forEach((p, idx) => {
                portPos.set(`${p.edge}:${p.role}`, {
                    x: cx(id) + (idx - (group.length - 1) / 2) * spacing,
                    y: cy(id) - boxH.get(id)! / 2
                })
            })
            continue
        }
        const px = cx(id) + (side === "e" ? +1 : -1) * boxW.get(id)! / 2

        /*  place the fixed ports at their given offsets  */
        const fixedOf = (p: PortRef) =>
            fixedY?.(p.edge, p.role)
        const place   = (p: PortRef, py: number) =>
            portPos.set(`${p.edge}:${p.role}`, { x: px, y: py })
        const taken: number[] = []
        for (const p of group.filter((p) => fixedOf(p) !== undefined)) {
            const py = cy(id) + fixedOf(p)!
            place(p, py)
            taken.push(py)
        }
        taken.sort((a, b) => a - b)

        /*  spread the remaining ports, ordered by their approach and
            at the spacing leaving room for the fixed ports, too (with
            no fixed port, simply centered on the box)  */
        const free    = group.filter((p) => fixedOf(p) === undefined)
        const otherOf = (p: PortRef) =>
            p.role === "s" ? edges[p.edge].target : edges[p.edge].source
        const keyOf   = (p: PortRef) =>
            approachY?.(p.edge) ?? cy(otherOf(p))
        free.sort((a, b) => (keyOf(a) - keyOf(b)) || (a.edge - b.edge))
        const n       = free.length + taken.length
        const spacing = Math.min(portGap, (boxH.get(id)! - PORT_PAD) / n)
        if (taken.length === 0) {
            free.forEach((p, idx) => place(p, cy(id) + (idx - (n - 1) / 2) * spacing))
            continue
        }

        /*  deal the free ports into the gaps between the fixed ports
            (each into the gap its approach falls into, overflowing into
            the neighboring gaps once a gap holds as many ports as fit
            into it at the spacing) and place the ports of every gap at
            their slots of the even distribution of all ports, shifted
            into the gap as far as needed (and squeezed if not fitting)  */
        const lo    = cy(id) - (boxH.get(id)! - PORT_PAD) / 2 + spacing / 2
        const hi    = cy(id) + (boxH.get(id)! - PORT_PAD) / 2 - spacing / 2
        const walls = [ lo - spacing, ...taken, hi + spacing ]
        const gapOf = (p: PortRef) =>
            taken.filter((ty) => ty < keyOf(p)).length
        const gaps  = walls.slice(1).map((wall, j) => ({
            lo:    Math.max(lo, walls[j] + spacing),
            hi:    Math.min(hi, wall - spacing),
            ports: free.filter((p) => gapOf(p) === j)
        }))
        const capOf = (gap: { lo: number, hi: number }) =>
            gap.hi < gap.lo ? 0 : Math.floor((gap.hi - gap.lo) / spacing) + 1
        for (let j = 0; j < gaps.length - 1; j++)
            while (gaps[j].ports.length > capOf(gaps[j]))
                gaps[j + 1].ports.unshift(gaps[j].ports.pop()!)
        for (let j = gaps.length - 1; j > 0; j--)
            while (gaps[j].ports.length > capOf(gaps[j]))
                gaps[j - 1].ports.push(gaps[j].ports.shift()!)
        let k = 0
        gaps.forEach((gap, j) => {
            const r     = gap.ports.length
            const step  = r > 1 ? Math.min(spacing, Math.max(gap.hi - gap.lo, 0) / (r - 1)) : spacing
            const first = Math.min(Math.max(cy(id) + (k + j - (n - 1) / 2) * spacing, gap.lo),
                gap.hi - (r - 1) * step)
            gap.ports.forEach((p, i) => place(p, first + i * step))
            k += r
        })
    }
    return portPos
}

/*  a channel/gutter track user: an edge entering the channel/gutter at
    cross-axis position posIn and leaving it at posOut (mirrored users
    enter from the far instead of the near side, hairpin users leave
    on the very side they entered from)  */
export interface TrackUser {
    edge:     number
    posIn:    number
    posOut:   number
    mirror:   boolean
    hairpin?: boolean
}

/*  the minimum cross-axis distance between the track-following segments
    of two edges sharing a track, keeping their rounded corners apart  */
const TRACK_CLEARANCE = 24

/*  the cross-axis positions of the stubs of a track user reaching the
    near side of the channel/gutter (its entering segment, or its
    exiting one if mirrored, or both if hairpin, or none if mirrored
    hairpin) and the far side  */
const nears = (u: TrackUser): number[] =>
    u.hairpin ? (u.mirror ? [] : [ u.posIn, u.posOut ]) : [ u.mirror ? u.posOut : u.posIn ]
const fars  = (u: TrackUser): number[] =>
    u.hairpin ? (u.mirror ? [ u.posIn, u.posOut ] : []) : [ u.mirror ? u.posIn : u.posOut ]

/*  the number of crossings caused by placing user a on a nearer track
    than user b: the far-side stubs of a (its exiting segment, or its
    entering one if mirrored) cross the track-following segment of b,
    and the near-side stubs of b cross the one of a (a stub touching
    the end of a segment counts too, as it would overlap a corner)  */
const trackCrossings = (a: TrackUser, b: TrackUser, farsA: number[], nearsB: number[]): number => {
    const within = (u: TrackUser, pos: number): boolean =>
        pos >= Math.min(u.posIn, u.posOut) && pos <= Math.max(u.posIn, u.posOut)
    let n = 0
    for (const pos of farsA)
        if (within(b, pos))
            n++
    for (const pos of nearsB)
        if (within(a, pos))
            n++
    return n
}

/*  the number of collinear overlaps caused by placing user a on a
    nearer track than user b: a far-side stub of a and a near-side stub
    of b at the very same cross-axis position run on top of each other
    between the two tracks (unlike a crossing, which is still readable
    through its hop, an overlap merges the two edges visually)  */
const trackOverlaps = (farsA: number[], nearsB: number[]): number => {
    let n = 0
    for (const pos of farsA)
        for (const near of nearsB)
            if (near === pos) {
                n++
                break
            }
    return n
}

/*  the maximum number of users for which the crossing-minimal track
    order is determined exactly (the effort doubles with every user)  */
const TRACK_EXACT_MAX = 14

/*  the maximum number of users for which the local search tries blocks
    of any length and restarts after every improving move (beyond it,
    the search is bounded to blocks of at most TRACK_BLOCK_MAX users and
    at most TRACK_PASSES_MAX passes, as the restarting search grows too
    fast with hundreds of users)  */
const TRACK_SEARCH_MAX = 100
const TRACK_BLOCK_MAX  = 8
const TRACK_PASSES_MAX = 100

/*  reorder the seeded track users to the order causing the fewest
    overlaps and then the fewest crossings, with ties broken toward the
    seed order: for small user sets exactly, by a dynamic programming
    over the user subsets (the linear ordering problem), for larger
    ones by a local search moving blocks of adjacent users while this
    reduces the overlaps/crossings  */
const minimizeCrossings = (seed: TrackUser[]): TrackUser[] => {
    const n = seed.length
    if (n < 2)
        return seed

    /*  the weighted cost of placing seed user i before seed user j: the
        overlaps dominate (one outweighs all crossings possible among the
        users, at most three per pair), then the crossings, and finally
        a seed order inversion breaks ties (the near-side and far-side
        stubs of every user are determined once, as the matrix grows
        quadratically with the users, and the flat matrix is a plain
        array, so its mostly small integers stay unboxed, unlike in a
        "Float64Array", whose doubles slow down the local search)  */
    const nearsOf = seed.map(nears)
    const farsOf  = seed.map(fars)
    const cost: number[] = []
    for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
            cost.push((trackOverlaps(farsOf[i], nearsOf[j]) * 2 * n * n +
                trackCrossings(seed[i], seed[j], farsOf[i], nearsOf[j])) * n * n + (i > j ? 1 : 0))
    let order: number[]
    if (n <= TRACK_EXACT_MAX) {
        const best = new Float64Array(1 << n).fill(Infinity)
        const last = new Int8Array(1 << n)
        best[0] = 0
        for (let s = 1; s < (1 << n); s++) {
            for (let u = 0; u < n; u++) {
                if ((s & (1 << u)) === 0)
                    continue
                const rest = s & ~(1 << u)
                let total = best[rest]
                for (let v = 0; v < n; v++)
                    if ((rest & (1 << v)) !== 0)
                        total += cost[v * n + u]
                if (total < best[s]) {
                    best[s] = total
                    last[s] = u
                }
            }
        }
        order = []
        for (let s = (1 << n) - 1; s !== 0; s &= ~(1 << last[s]))
            order.unshift(last[s])
    }
    else {
        /*  move a block of adjacent users over the run of users behind
            or ahead of it, as soon as this reduces the cost (which only
            the pairs between the block and the run passed contribute
            to, so the cost change is accumulated while extending the
            run), until no such move remains (a single-user move is
            the block move of length one, while the longer blocks let
            a group of users pass an obstacle which none of its members
            could pass on their own); for large user sets the search is
            bounded instead: per block, the best move over the runs
            behind and ahead of it is applied, and the search continues
            with the next block instead of restarting  */
        order = seed.map((_, i) => i)

        /*  precompute the cost change of swapping two users once:
            diff[a * n + b] is the cost of placing user a before user b
            minus the cost of the reverse placement  */
        const diff: number[] = []
        for (let a = 0; a < n; a++)
            for (let b = 0; b < n; b++)
                diff.push(cost[a * n + b] - cost[b * n + a])
        const bounded = n > TRACK_SEARCH_MAX
        const maxLen  = bounded ? Math.min(n - 1, TRACK_BLOCK_MAX) : n - 1
        const passes  = bounded ? TRACK_PASSES_MAX : Infinity
        for (let improved = true, pass = 0; improved && pass < passes; pass++) {
            improved = false
            for (let len = 1; len <= maxLen; len++) {
                for (let i = 0; i + len <= n; i++) {
                    let best    = 0
                    let target  = -1
                    let forward = true
                    let delta   = 0
                    for (let k = i + len; k < n; k++) {
                        const row = order[k] * n
                        for (let b = i; b < i + len; b++)
                            delta += diff[row + order[b]]
                        if (delta < best) {
                            best    = delta
                            target  = k
                            forward = true
                            if (!bounded)
                                break
                        }
                    }
                    delta = 0
                    for (let k = i - 1; k >= 0; k--) {
                        if (target >= 0 && !bounded)
                            break
                        const other = order[k]
                        for (let b = i; b < i + len; b++)
                            delta += diff[order[b] * n + other]
                        if (delta < best) {
                            best    = delta
                            target  = k
                            forward = false
                            if (!bounded)
                                break
                        }
                    }
                    if (target >= 0) {
                        if (forward)
                            order.splice(target - len + 1, 0, ...order.splice(i, len))
                        else
                            order.splice(target, 0, ...order.splice(i, len))
                        improved = true
                        if (!bounded)
                            break
                    }
                }
                if (improved && !bounded)
                    break
            }
        }
    }
    return order.map((i) => seed[i])
}

/*  assign the parallel tracks within a channel or gutter: the users are
    ordered by their entry/exit positions, so that a track-following
    segment never has to cross the entering segment of a parallel
    neighbor (back turners get near tracks entry-position-ordered,
    forward turners far tracks, reversed for mirrored users which
    enter the channel/gutter from the far side), and this seed order
    is then refined to the one causing the fewest crossings; users
    whose track-following segments occupy disjoint cross-axis spans
    share a track, so fewer tracks are used and they stay centered  */
export const assignTracks = (users: TrackUser[], width: number, pad: number, gap: number): Map<number, number> => {
    const order = (list: TrackUser[], mirror: boolean): TrackUser[] => {
        const dir   = mirror ? -1 : +1
        const backs = list.filter((u) => u.posOut <  u.posIn)
            .sort((a, b) => dir * ((a.posIn - b.posIn) || (a.posOut - b.posOut)))
        const fores = list.filter((u) => u.posOut >= u.posIn)
            .sort((a, b) => dir * ((b.posIn - a.posIn) || (b.posOut - a.posOut)))
        return [ ...backs, ...fores ]
    }
    const ordered = minimizeCrossings([
        ...order(users.filter((u) => !u.mirror), false),
        ...order(users.filter((u) =>  u.mirror), true)
    ])

    /*  pack the ordered users onto tracks: overlapping users keep their
        relative crossing-avoiding order by always taking a farther track
        than every earlier overlapping user, while span-disjoint users
        share a track (their entry/exit segments lie outside each other's
        span, so sharing can never introduce a crossing)  */
    const overlap = (a: TrackUser, b: TrackUser): boolean =>
        Math.min(a.posIn, a.posOut) < Math.max(b.posIn, b.posOut) + TRACK_CLEARANCE
        && Math.min(b.posIn, b.posOut) < Math.max(a.posIn, a.posOut) + TRACK_CLEARANCE
    const trackOf = new Map<number, number>()
    let   tracks  = 0
    ordered.forEach((u, idx) => {
        let t = 0
        for (let j = 0; j < idx; j++)
            if (overlap(ordered[j], u))
                t = Math.max(t, trackOf.get(ordered[j].edge)! + 1)
        trackOf.set(u.edge, t)
        tracks = Math.max(tracks, t + 1)
    })

    /*  spread the used tracks centered within the channel/gutter  */
    const step    = Math.min(gap, (width - pad) / Math.max(tracks - 1, 1))
    const offsets = new Map<number, number>()
    for (const [ edge, t ] of trackOf)
        offsets.set(edge, (t - (tracks - 1) / 2) * step)
    return offsets
}

/*  detect edge crossings: for every horizontal segment determine the
    vertical segments of all other edges crossing it (hops are always
    drawn on the horizontal segment of the crossing pair)  */
export const computeHops = (polys: Poly[]): Map<number, number[]>[] => {
    /*  collect all vertical segments once, instead of re-scanning
        every polyline again for each single horizontal segment  */
    const verts: { idx: number, owner: number, x: number, y1: number, y2: number }[] = []
    polys.forEach((poly, j) => {
        for (let m = 0; m < poly.length - 1; m++) {
            const [ c, d ] = [ poly[m], poly[m + 1] ]
            if (c[0] !== d[0])
                continue
            verts.push({ idx: verts.length, owner: j, x: c[0], y1: Math.min(c[1], d[1]), y2: Math.max(c[1], d[1]) })
        }
    })

    /*  sweep the vertical segments ordered by their position, so every
        horizontal segment only visits the ones within its own span (found
        by a binary search), and report the crossing ones in their original
        order of collection  */
    const byX = verts.slice().sort((a, b) => a.x - b.x)
    return polys.map((poly, i) => {
        const result = new Map<number, number[]>()
        for (let k = 0; k < poly.length - 1; k++) {
            const [ a, b ] = [ poly[k], poly[k + 1] ]
            if (a[1] !== b[1])
                continue
            const hy  = a[1]
            const lo  = Math.min(a[0], b[0]) + 1
            const hi  = Math.max(a[0], b[0]) - 1
            let   l   = 0
            let   h   = byX.length
            while (l < h) {
                const m = (l + h) >>> 1
                if (byX[m].x > lo)
                    h = m
                else
                    l = m + 1
            }
            const found: typeof verts = []
            for (let m = l; m < byX.length && byX[m].x < hi; m++) {
                const v = byX[m]
                if (v.owner !== i && hy > v.y1 + 1 && hy < v.y2 - 1)
                    found.push(v)
            }
            if (found.length > 0)
                result.set(k, found.sort((a, b) => a.idx - b.idx).map((v) => v.x))
        }
        return result
    })
}

/*  the Manhattan length of an orthogonal polyline segment  */
const len = (a: [ number, number ], b: [ number, number ]): number =>
    Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])

/*  convert an edge polyline into an SVG path with rounded corners
    at the bends and semi-circular hops at the crossing points  */
export const pathOf = (poly: Poly, hop: Map<number, number[]>, rounding: number, hopRadius: number): string => {
    const radius = (k: number): number => {
        if (k <= 0 || k >= poly.length - 1)
            return 0
        let r = Math.min(rounding, len(poly[k - 1], poly[k]) / 2, len(poly[k], poly[k + 1]) / 2)

        /*  shrink the corner rounding when a crossing hop sits close
            to the bend, so the hop is never swallowed by the arc  */
        for (const seg of [ k - 1, k ])
            for (const hx of hop.get(seg) ?? [])
                r = Math.min(r, Math.max(Math.abs(hx - poly[k][0]) - hopRadius - 2, 4))
        return r
    }
    const d: string[] = []
    for (let k = 0; k < poly.length - 1; k++) {
        const [ a, b ] = [ poly[k], poly[k + 1] ]
        const l   = len(a, b)
        const ux  = (b[0] - a[0]) / l
        const uy  = (b[1] - a[1]) / l
        const r0  = radius(k)
        const r1  = radius(k + 1)
        const p0: [ number, number ] = [ a[0] + ux * r0, a[1] + uy * r0 ]
        const p1: [ number, number ] = [ b[0] - ux * r1, b[1] - uy * r1 ]
        if (k === 0)
            d.push(`M ${p0[0]} ${p0[1]}`)
        if (a[1] === b[1] && hop.has(k)) {
            const dir = Math.sign(b[0] - a[0])
            const xs  = hop.get(k)!
                .filter((hx) => (hx - p0[0]) * dir > 2 && (p1[0] - hx) * dir > 2)
                .sort((m, n) => (m - n) * dir)

            /*  merge closely adjacent crossings into groups, each
                rendered as one single wide "long hop" arc (crossings
                are merged whenever the flat line piece left between
                their individual hops would be shorter than 14px)  */
            const groups: number[][] = []
            for (const hx of xs) {
                const g = groups.at(-1)
                if (g !== undefined && Math.abs(hx - g.at(-1)!) <= hopRadius * 2 + 14)
                    g.push(hx)
                else
                    groups.push([ hx ])
            }
            for (const g of groups) {
                let x1 = g[0] - dir * hopRadius
                let x2 = g.at(-1)! + dir * hopRadius

                /*  clamp the arc into the drawable segment part, so
                    crossings close to a corner still get their hop  */
                if ((x1 - p0[0]) * dir < 0)
                    x1 = p0[0]
                if ((p1[0] - x2) * dir < 0)
                    x2 = p1[0]
                d.push(`L ${x1} ${a[1]}`)
                d.push(`A ${Math.abs(x2 - x1) / 2} ${hopRadius} 0 0 ${dir > 0 ? 1 : 0} ${x2} ${a[1]}`)
            }
        }
        d.push(`L ${p1[0]} ${p1[1]}`)
        if (k < poly.length - 2) {
            const c  = poly[k + 1]
            const n  = poly[k + 2]
            const nl = len(c, n)
            const q: [ number, number ] = [
                c[0] + (n[0] - c[0]) / nl * r1,
                c[1] + (n[1] - c[1]) / nl * r1
            ]
            d.push(`Q ${b[0]} ${b[1]} ${q[0]} ${q[1]}`)
        }
    }
    return d.join(" ")
}

/*  determine a point on a polyline at a given fraction of its length  */
export const pointAt = (poly: Poly, fraction: number): { x: number, y: number, horizontal: boolean } => {
    const lens  = poly.slice(0, -1).map((p, k) => len(p, poly[k + 1]))
    const total = lens.reduce((a, b) => a + b, 0)
    let want    = total * fraction
    for (let k = 0; k < lens.length; k++) {
        if (want <= lens[k] || k === lens.length - 1) {
            const t = lens[k] > 0 ? want / lens[k] : 0
            return {
                x: poly[k][0] + (poly[k + 1][0] - poly[k][0]) * Math.min(t, 1),
                y: poly[k][1] + (poly[k + 1][1] - poly[k][1]) * Math.min(t, 1),
                horizontal: poly[k][1] === poly[k + 1][1]
            }
        }
        want -= lens[k]
    }
    return { x: poly[0][0], y: poly[0][1], horizontal: true }
}

