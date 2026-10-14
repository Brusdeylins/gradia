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

/*  the separation of the adjacent ports of the sides of a node: the
    configured one, raised to what the arity labels demand once any edge
    carries one, as such a label sits ARITY_PAD below the line of the
    port above it, whose arrow head reaches down by half its height, and
    needs two more ARITY_PAD of air between the two, so it stays
    attributable to its own arrow instead of drifting into the
    neighboring one, raised likewise to what the name labels demand once
    the edge ends of named bundles are merged into one port, as their
    one name label then sits beside that port the same way, and, for a
    node a named edge runs into, raised to what its name label demands,
    as it sits beside the stub of its edge the same way, but set back
    behind the arrow head  */
export const portGapOf = (edges: Edge[], config: Config,
    merged?: (edge: number, role: "s" | "t") => string | undefined): (id: string) => number => {
    let gap = edges.some((edge) => edge.arity !== undefined) ?
        Math.max(config["size-edge-port-gap"],
            Math.ceil(3 * ARITY_PAD + arityHeight(config) + ARROW_H / 2)) :
        config["size-edge-port-gap"]
    if (merged !== undefined && edges.some((edge, i) =>
        edge.name !== undefined && (merged(i, "s") !== undefined || merged(i, "t") !== undefined)))
        gap = Math.max(gap, Math.ceil(3 * ARITY_PAD + config["size-font-edge"] + 4 + ARROW_H / 2))
    const named = new Set(edges.filter((edge) => edge.name !== undefined && edge.source !== edge.target)
        .map((edge) => edge.target))
    const gapNamed = Math.max(gap, 3 * ARITY_PAD + config["size-font-edge"] + 4)
    return (id) => named.has(id) ? gapNamed : gap
}

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
    separated by at most the portGap of their node (less, if the node
    box is too small to hold them all). A port with a fixed vertical
    offset from the box center (fixedY, the edge ends attaching to a
    container box at the position of the inner gate node) is placed
    exactly there and the distributed ports of the same side are dealt
    into the gaps around it. The edge ends merged into one port (merged,
    the edge ends of a bundle running into its node as one) take the
    place of a single port, ordered by the mean of their approaches  */
export const assignPorts = (
    edges:      Edge[],
    sides:      { s: Side, t: Side }[],
    cx:         (id: string) => number,
    cy:         (id: string) => number,
    boxW:       Map<string, number>,
    boxH:       Map<string, number>,
    portGap:    (id: string) => number,
    approachY?: (edge: number) => number | undefined,
    fixedY?:    (edge: number, role: "s" | "t") => number | undefined,
    merged?:    (edge: number, role: "s" | "t") => string | undefined
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

    /*  place the ports of each group, ordered by the opposite endpoint
        (with the merged edge ends of a group reduced to the first one of
        each merge, which stands for all of them, and the others placed
        at its port at the end)  */
    const portPos = new Map<string, { x: number, y: number }>()
    const mateOf  = new Map<string, string>()
    for (const [ key, all ] of portGroups) {
        const mates = new Map<PortRef, PortRef[]>()
        let   group = all
        if (merged !== undefined) {
            const first = new Map<string, PortRef>()
            group = all.filter((p) => {
                const m = fixedY?.(p.edge, p.role) === undefined ? merged(p.edge, p.role) : undefined
                if (m === undefined)
                    return true
                const rep = first.get(m)
                if (rep === undefined) {
                    first.set(m, p)
                    mates.set(p, [ p ])
                    return true
                }
                mates.get(rep)!.push(p)
                mateOf.set(`${p.edge}:${p.role}`, `${rep.edge}:${rep.role}`)
                return false
            })
        }

        const sep     = key.lastIndexOf(":")  /*  ids may contain a colon themselves  */
        const id      = key.slice(0, sep)
        const side    = key.slice(sep + 1)

        /*  spread the north side ports along the top side, in reverse
            edge order, so the innermost of the nested self-loops
            attaches closest to the top-right box corner  */
        if (side === "n") {
            group.sort((a, b) => b.edge - a.edge)
            const spacing = Math.min(portGap(id), (boxW.get(id)! - PORT_PAD) / group.length)
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
        const approach = (p: PortRef) =>
            approachY?.(p.edge) ?? cy(otherOf(p))
        const keyOf   = (p: PortRef) => {
            const list = mates.get(p)
            return list === undefined ? approach(p) :
                list.reduce((sum, q) => sum + approach(q), 0) / list.length
        }
        free.sort((a, b) => (keyOf(a) - keyOf(b)) || (a.edge - b.edge))
        const n       = free.length + taken.length
        const spacing = Math.min(portGap(id), (boxH.get(id)! - PORT_PAD) / n)
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

    for (const [ mate, rep ] of mateOf)
        portPos.set(mate, portPos.get(rep)!)
    return portPos
}

/*  a channel/gutter track user: an edge entering the channel/gutter at
    cross-axis position posIn and leaving it at posOut (mirrored users
    enter from the far instead of the near side, hairpin users leave
    on the very side they entered from), optionally with the keys of
    the bundles it may join in a crowded channel/gutter (one per edge
    end it shares with other edges, e.g. the target node and side the
    remaining route of the edge leads to), or the key of the bundle it
    is bound to, as its edge end was merged with the ones of the other
    edges of the bundle into one port  */
export interface TrackUser {
    edge:     number
    posIn:    number
    posOut:   number
    mirror:   boolean
    hairpin?: boolean
    bundles?: string[]
    unit?:    string
}

/*  a track unit: a single track user, or a bundle of track users
    sharing one and the same track, with its representative entry/exit
    positions (the means of its users), its cross-axis span, and the
    positions of the stubs of all its users reaching the near and the
    far side of the channel/gutter, and the key of a bundle  */
interface TrackUnit {
    users:  TrackUser[]
    key?:   string
    posIn:  number
    posOut: number
    mirror: boolean
    lo:     number
    hi:     number
    nears:  number[]
    fars:   number[]
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

/*  the track unit of a single track user  */
const unitOf = (u: TrackUser): TrackUnit => ({
    users:  [ u ],
    posIn:  u.posIn,
    posOut: u.posOut,
    mirror: u.mirror,
    lo:     Math.min(u.posIn, u.posOut),
    hi:     Math.max(u.posIn, u.posOut),
    nears:  nears(u),
    fars:   fars(u)
})

/*  the number of crossings caused by placing unit a on a nearer track
    than unit b: the far-side stubs of a (its exiting segment, or its
    entering one if mirrored) cross the track-following segment of b,
    and the near-side stubs of b cross the one of a (a stub touching
    the end of a segment counts too, as it would overlap a corner)  */
const trackCrossings = (a: TrackUnit, b: TrackUnit): number => {
    let n = 0
    for (const pos of a.fars)
        if (pos >= b.lo && pos <= b.hi)
            n++
    for (const pos of b.nears)
        if (pos >= a.lo && pos <= a.hi)
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
    the search moves blocks of at most "TRACK_BLOCK_MAX" users, applies
    the best move per block and continues, for at most
    "TRACK_PASSES_MAX" passes, as the restarting search grows too fast
    with hundreds of users)  */
const TRACK_SEARCH_MAX = 100
const TRACK_BLOCK_MAX  = 8
const TRACK_PASSES_MAX = 100

/*  reorder the seeded track units to the order causing the fewest
    overlaps and then the fewest crossings, with ties broken toward the
    seed order: for small unit sets exactly, by a dynamic programming
    over the unit subsets (the linear ordering problem), for larger
    ones by a local search moving blocks of adjacent units while this
    reduces the overlaps/crossings  */
const minimizeCrossings = (seed: TrackUnit[]): TrackUnit[] => {
    const n = seed.length
    if (n < 2)
        return seed

    /*  the weighted cost of placing seed unit i before seed unit j: the
        overlaps dominate (one outweighs all crossings possible among the
        units, at most three per pair of single users, and at most the
        stubs of both units per pair of bundles), then the crossings,
        and finally a seed order inversion breaks ties  */
    const stubs   = seed.reduce((sum, u) => sum + u.nears.length + u.fars.length, 0)
    const weight  = stubs > 2 * n ? 2 * stubs * stubs : 2 * n * n
    const cost    = new Float64Array(n * n)
    for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
            cost[i * n + j] = (trackOverlaps(seed[i].fars, seed[j].nears) * weight +
                trackCrossings(seed[i], seed[j])) * n * n + (i > j ? 1 : 0)
    let order: number[]
    if (n <= TRACK_EXACT_MAX) {
        /*  the cost of placing all users of a subset before a user u:
            col[s * n + u] is derived from the subset without its lowest
            user, so all subsets take linear instead of quadratic effort
            (all costs are small integers, so the sums are exact,
            whatever their summation order)  */
        const col = new Float64Array((1 << n) * n)
        for (let s = 1; s < (1 << n); s++) {
            const low  = (31 - Math.clz32(s & -s)) * n
            const prev = (s & (s - 1)) * n
            for (let u = 0; u < n; u++)
                col[s * n + u] = col[prev + u] + cost[low + u]
        }
        const best = new Float64Array(1 << n).fill(Infinity)
        const last = new Int8Array(1 << n)
        best[0] = 0
        for (let s = 1; s < (1 << n); s++) {
            for (let u = 0; u < n; u++) {
                if ((s & (1 << u)) === 0)
                    continue
                const rest  = s & ~(1 << u)
                const total = best[rest] + col[rest * n + u]
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
            groups of users pass an obstacle which none of its users
            could pass on its own), with the cost change of swapping two
            users precomputed once: diff[a * n + b] is the cost of placing
            user a before user b minus the cost of the reverse placement  */
        const diff = new Float64Array(n * n)
        for (let a = 0; a < n; a++)
            for (let b = 0; b < n; b++)
                diff[a * n + b] = cost[a * n + b] - cost[b * n + a]
        order = seed.map((_, i) => i)
        if (n > TRACK_SEARCH_MAX) {
            /*  bounded search for large user sets: per block, determine
                the best move over the run behind and ahead of it, apply
                it, and continue with the next block  */
            const maxLen = Math.min(n - 1, TRACK_BLOCK_MAX)
            for (let improved = true, pass = 0; improved && pass < TRACK_PASSES_MAX; pass++) {
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
                            }
                        }
                        delta = 0
                        for (let k = i - 1; k >= 0; k--) {
                            const other = order[k]
                            for (let b = i; b < i + len; b++)
                                delta += diff[order[b] * n + other]
                            if (delta < best) {
                                best    = delta
                                target  = k
                                forward = false
                            }
                        }
                        if (target >= 0) {
                            if (forward)
                                order.splice(target - len + 1, 0, ...order.splice(i, len))
                            else
                                order.splice(target, 0, ...order.splice(i, len))
                            improved = true
                        }
                    }
                }
            }
            return order.map((i) => seed[i])
        }
        /*  restarting search for smaller user sets: the cost change of
            passing a block over a user is the difference of two prefix
            sums over the current order, determined anew after every move
            (all costs are integers far below 2^53 for at most
            "TRACK_SEARCH_MAX" users, so these differences are exact)  */
        const w      = n + 1
        const ahead  = new Float64Array(n * w)
        const behind = new Float64Array(n * w)
        for (let improved = true; improved;) {
            improved = false
            for (let k = 0; k < n; k++) {
                for (let p = 0; p < n; p++) {
                    ahead[k * w + p + 1]  = ahead[k * w + p]  + diff[order[k] * n + order[p]]
                    behind[k * w + p + 1] = behind[k * w + p] + diff[order[p] * n + order[k]]
                }
            }
            for (let len = 1; len < n && !improved; len++) {
                for (let i = 0; i + len <= n && !improved; i++) {
                    let delta = 0
                    for (let k = i + len; k < n && !improved; k++) {
                        delta += ahead[k * w + i + len] - ahead[k * w + i]
                        if (delta < 0) {
                            order.splice(k - len + 1, 0, ...order.splice(i, len))
                            improved = true
                        }
                    }
                    delta = 0
                    for (let k = i - 1; k >= 0 && !improved; k--) {
                        delta += behind[k * w + i + len] - behind[k * w + i]
                        if (delta < 0) {
                            order.splice(k, 0, ...order.splice(i, len))
                            improved = true
                        }
                    }
                }
            }
        }
    }
    return order.map((i) => seed[i])
}

/*  order the track units by their entry/exit positions, so that a
    track-following segment never has to cross the entering segment of
    a parallel neighbor (back turners get near tracks entry-position-
    ordered, forward turners far tracks, reversed for mirrored units
    which enter the channel/gutter from the far side), refine this seed
    order to the one causing the fewest crossings, and pack the ordered
    units onto tracks: overlapping units keep their relative
    crossing-avoiding order by always taking a farther track than every
    earlier overlapping unit, while span-disjoint units share a track
    (their entry/exit segments lie outside each other's span, so
    sharing can never introduce a crossing)  */
const packTracks = (units: TrackUnit[]): { trackOf: Map<TrackUnit, number>, tracks: number } => {
    const order = (list: TrackUnit[], mirror: boolean): TrackUnit[] => {
        const dir   = mirror ? -1 : +1
        const backs = list.filter((u) => u.posOut <  u.posIn)
            .sort((a, b) => dir * ((a.posIn - b.posIn) || (a.posOut - b.posOut)))
        const fores = list.filter((u) => u.posOut >= u.posIn)
            .sort((a, b) => dir * ((b.posIn - a.posIn) || (b.posOut - a.posOut)))
        return [ ...backs, ...fores ]
    }
    const ordered = minimizeCrossings([
        ...order(units.filter((u) => !u.mirror), false),
        ...order(units.filter((u) =>  u.mirror), true)
    ])
    const overlap = (a: TrackUnit, b: TrackUnit): boolean =>
        a.lo < b.hi + TRACK_CLEARANCE && b.lo < a.hi + TRACK_CLEARANCE
    const trackOf = new Map<TrackUnit, number>()
    let   tracks  = 0
    ordered.forEach((u, idx) => {
        let t = 0
        for (let j = 0; j < idx; j++)
            if (overlap(ordered[j], u))
                t = Math.max(t, trackOf.get(ordered[j])! + 1)
        trackOf.set(u, t)
        tracks = Math.max(tracks, t + 1)
    })
    return { trackOf, tracks }
}

/*  the maximum number of users whose spans (extended by the track
    clearance, exactly as the track packing compares them) overlap at
    one and the same position  */
const overlapDepth = (users: TrackUser[]): number => {
    const events: [ number, number ][] = []
    for (const u of users) {
        events.push([ Math.min(u.posIn, u.posOut), +1 ])
        events.push([ Math.max(u.posIn, u.posOut) + TRACK_CLEARANCE, -1 ])
    }
    events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
    let depth = 0
    let max   = 0
    for (const [ , delta ] of events) {
        depth += delta
        max = Math.max(max, depth)
    }
    return max
}

/*  group the users of a crowded channel/gutter into bundles sharing a
    track: every bundle key (qualified by the way its users pass
    through, as only the users entering and leaving on the same sides
    can share a track) collects the users offering it, the keys are
    dealt out largest first, and every user not yet dealt out joins
    the first key offering it to at least one more such user, while
    all other users stay single (except the users bound to a bundle,
    which always form it, before any other bundle is dealt out). A
    single user passing straight through (entering and leaving at the
    very same position, hence drawn as a straight line) needs no track
    at all and is dropped  */
const bundleUnits = (users: TrackUser[]): TrackUnit[] => {
    const members = new Map<string, TrackUser[]>()
    const add     = (key: string, u: TrackUser) => {
        const list = members.get(key)
        if (list === undefined)
            members.set(key, [ u ])
        else
            list.push(u)
    }
    for (const u of users) {
        if (u.unit !== undefined)
            add(`=:${u.unit}`, u)
        else
            for (const key of u.bundles ?? [])
                add(`${u.mirror ? "m" : "-"}${u.hairpin ? "h" : "-"}:${key}`, u)
    }
    const bound = (key: string) => key.startsWith("=:") ? 1 : 0
    const keys  = Array.from(members.keys()).sort((a, b) =>
        (bound(b) - bound(a)) || (members.get(b)!.length - members.get(a)!.length))
    const dealt = new Set<TrackUser>()
    const units: TrackUnit[] = []
    for (const key of keys) {
        const list = members.get(key)!.filter((u) => !dealt.has(u))
        if (list.length < (bound(key) ? 1 : 2))
            continue
        for (const u of list)
            dealt.add(u)
        units.push({
            users:  list,
            key:    key.slice(key.indexOf(":") + 1),
            posIn:  list.reduce((sum, u) => sum + u.posIn,  0) / list.length,
            posOut: list.reduce((sum, u) => sum + u.posOut, 0) / list.length,
            mirror: list[0].mirror,
            lo:     Math.min(...list.map((u) => Math.min(u.posIn, u.posOut))),
            hi:     Math.max(...list.map((u) => Math.max(u.posIn, u.posOut))),
            nears:  list.flatMap(nears),
            fars:   list.flatMap(fars)
        })
    }
    for (const u of users)
        if (!dealt.has(u) && (u.hairpin || u.posIn !== u.posOut))
            units.push(unitOf(u))
    return units
}

/*  the assigned tracks of a channel or gutter: the cross-axis offset of
    every user from the channel/gutter center, the width/height a
    crowded channel/gutter needs for its tracks (0 if not crowded), and
    the edges sharing their track as members of a bundle (with the key
    of their bundle)  */
export interface TrackAssignment {
    offsets: Map<number, number>
    need:    number
    bundled: Map<number, string>
}

/*  assign the parallel tracks within a channel or gutter (see packTracks
    for the crossing-avoiding ordering scheme; users whose
    track-following segments occupy disjoint cross-axis spans share a
    track, so fewer tracks are used and they stay centered) and spread
    the used tracks centered within the channel/gutter. A crowded
    channel/gutter, whose tracks do not fit at the full track gap
    into its width, bundles the users sharing an edge end onto one
    track each, never spreads its tracks closer than the minimum track
    gap, and reports the width its tracks need, the given frame around
    them included (which may be less than its width, once the bundles
    fit at the full track gap, or more, if they do not fit even at the
    minimum track gap; a channel/gutter with users bound to a bundle
    counts as crowded, as it was found crowded when binding them)  */
export const assignTracks = (users: TrackUser[], width: number, pad: number, gap: number,
    gapMin: number, frame: number): TrackAssignment => {
    /*  the users overlapping at one and the same position need tracks of
        their own, whatever their order, so a channel/gutter whose
        deepest overlap already exceeds the tracks fitting at the full
        track gap is crowded without determining its (costly) order  */
    const depth   = overlapDepth(users)
    const crowded = users.some((u) => u.unit !== undefined)
        || (gap > 0 && depth > 1 && depth > 1 + (width - pad) / gap)
    let   { trackOf, tracks } = crowded ? { trackOf: new Map<TrackUnit, number>(), tracks: 0 } :
        packTracks(users.map(unitOf))
    let   step    = Math.min(gap, (width - pad) / Math.max(tracks - 1, 1))
    let   need    = 0
    const bundled = new Map<number, string>()
    if (crowded || (tracks > 1 && step < gap)) {
        ({ trackOf, tracks } = packTracks(bundleUnits(users)))
        step = Math.max(Math.min(gap, (width - pad) / Math.max(tracks - 1, 1)), gapMin)
        need = frame + (tracks - 1) * step
        for (const unit of trackOf.keys())
            if (unit.key !== undefined && unit.users.length > 1)
                for (const u of unit.users)
                    bundled.set(u.edge, unit.key)
    }
    const offsets = new Map<number, number>()
    for (const [ unit, t ] of trackOf)
        for (const u of unit.users)
            offsets.set(u.edge, (t - (tracks - 1) / 2) * step)
    for (const u of users)
        if (!offsets.has(u.edge))
            offsets.set(u.edge, 0)
    return { offsets, need, bundled }
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

/*  determine the junctions of the polylines of bundled edges: the bends
    at which lines of at least three different directions meet, i.e.,
    where a stub joins a shared track running on in both directions,
    or where a shared track forks (a mere common corner of the bundled
    edges, where all of them turn alike, is no junction)  */
export const junctionsOf = (polys: Poly[]): Poly => {
    /*  index the vertical segments by their X and the horizontal
        segments by their Y position  */
    const verts = new Map<number, [ number, number ][]>()
    const horzs = new Map<number, [ number, number ][]>()
    const add   = (map: Map<number, [ number, number ][]>, at: number, a: number, b: number) => {
        const list = map.get(at)
        if (list === undefined)
            map.set(at, [ [ Math.min(a, b), Math.max(a, b) ] ])
        else
            list.push([ Math.min(a, b), Math.max(a, b) ])
    }
    for (const poly of polys) {
        for (let k = 0; k < poly.length - 1; k++) {
            const [ a, b ] = [ poly[k], poly[k + 1] ]
            if (a[0] === b[0])
                add(verts, a[0], a[1], b[1])
            else
                add(horzs, a[1], a[0], b[0])
        }
    }

    /*  collect the directions the lines leave every bend into (up,
        down, left, right) and keep the bends with at least three  */
    const seen = new Set<string>()
    const out: Poly = []
    for (const poly of polys) {
        for (let k = 1; k < poly.length - 1; k++) {
            const [ x, y ] = poly[k]
            const key = `${x}:${y}`
            if (seen.has(key))
                continue
            seen.add(key)
            let dirs = 0
            for (const [ lo, hi ] of verts.get(x) ?? [])
                dirs |= (lo < y && y <= hi ? 1 : 0) | (lo <= y && y < hi ? 2 : 0)
            for (const [ lo, hi ] of horzs.get(y) ?? [])
                dirs |= (lo < x && x <= hi ? 4 : 0) | (lo <= x && x < hi ? 8 : 0)
            if ((dirs & 1) + ((dirs >> 1) & 1) + ((dirs >> 2) & 1) + ((dirs >> 3) & 1) >= 3)
                out.push([ x, y ])
        }
    }
    return out
}

/*  a piece of an edge polyline to draw: a sub-polyline, the index of
    the segment of the whole polyline it starts on, and whether it runs
    up to the end of the whole polyline (and hence carries its arrow head)  */
export interface Piece {
    poly: Poly
    from: number
    end:  boolean
}

/*  split the polylines of the bundled edges into the pieces not yet
    covered by the polyline of an earlier bundled edge, so the segments
    the edges of a bundle share (their common track and the stub of a
    merged port) are drawn exactly once instead of once per edge, where
    the anti-aliased fringes of the coinciding lines would add up into a
    visibly thicker line: the first edge of a bundle keeps its whole
    route, while every further edge keeps its own stub only, up to the
    junction at which it joins (or from the one at which it leaves) the
    shared track (the other edges are kept whole in a single piece)  */
export const piecesOf = (polys: Poly[], bundled?: boolean[]): Piece[][] => {
    /*  the covered intervals of the vertical lines by their X and of
        the horizontal lines by their Y position, kept sorted and merged  */
    const verts = new Map<number, [ number, number ][]>()
    const horzs = new Map<number, [ number, number ][]>()
    const cover = (map: Map<number, [ number, number ][]>, at: number, a: number, b: number) => {
        const list = [ ...(map.get(at) ?? []), [ Math.min(a, b), Math.max(a, b) ] as [ number, number ] ]
            .sort((m, n) => m[0] - n[0])
        const merged: [ number, number ][] = []
        for (const [ lo, hi ] of list) {
            const last = merged.at(-1)
            if (last !== undefined && lo <= last[1])
                last[1] = Math.max(last[1], hi)
            else
                merged.push([ lo, hi ])
        }
        map.set(at, merged)
    }

    /*  the uncovered intervals of a line between two positions, in the
        order from the first to the second position  */
    const uncovered = (covered: [ number, number ][] | undefined, a: number, b: number): [ number, number ][] => {
        const out: [ number, number ][] = []
        let pos = Math.min(a, b)
        for (const [ lo, hi ] of covered ?? []) {
            if (hi <= pos || lo >= Math.max(a, b))
                continue
            if (lo > pos)
                out.push([ pos, lo ])
            pos = Math.max(pos, hi)
        }
        if (pos < Math.max(a, b))
            out.push([ pos, Math.max(a, b) ])
        return a <= b ? out : out.reverse().map(([ lo, hi ]) => [ hi, lo ])
    }

    return polys.map((poly, i) => {
        if (bundled?.[i] !== true)
            return [ { poly, from: 0, end: true } ]

        /*  collect the uncovered parts of the segments, continuing the
            current piece as long as they adjoin  */
        const pieces: Piece[] = []
        let current: Piece | undefined
        for (let k = 0; k < poly.length - 1; k++) {
            const [ a, b ] = [ poly[k], poly[k + 1] ]
            const vertical = a[0] === b[0]
            const point = (v: number): [ number, number ] => vertical ? [ a[0], v ] : [ v, a[1] ]
            const parts = vertical ?
                uncovered(verts.get(a[0]), a[1], b[1]) :
                uncovered(horzs.get(a[1]), a[0], b[0])
            for (const [ s, t ] of parts) {
                const last = current?.poly.at(-1)
                if (current !== undefined && last !== undefined && last[0] === point(s)[0] && last[1] === point(s)[1])
                    current.poly.push(point(t))
                else {
                    if (current !== undefined)
                        pieces.push(current)
                    current = { poly: [ point(s), point(t) ], from: k, end: false }
                }
            }
            if (current !== undefined && (parts.length === 0 || parts.at(-1)![1] !== (vertical ? b[1] : b[0]))) {
                pieces.push(current)
                current = undefined
            }
        }
        if (current !== undefined)
            pieces.push({ ...current, end: true })

        /*  let the polyline of this edge cover the ones of the later edges  */
        for (let k = 0; k < poly.length - 1; k++) {
            const [ a, b ] = [ poly[k], poly[k + 1] ]
            if (a[0] === b[0])
                cover(verts, a[0], a[1], b[1])
            else
                cover(horzs, a[1], a[0], b[0])
        }
        return pieces
    })
}

/*  the Manhattan length of an orthogonal polyline segment  */
const len = (a: [ number, number ], b: [ number, number ]): number =>
    Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])

/*  convert an edge polyline into an SVG path with rounded corners
    at the bends (except the bends at a junction of bundled edges,
    where the edge turns sharply at the junction mark) and
    semi-circular hops at the crossing points (with "bridges" set, as
    for a diagram with crowded channels or gutters, whose closely
    spaced parallel tracks would turn the hops into a wavy line, the
    crossings are merged more generously and a merged run is spanned
    by one flat bridge instead of one wide arc), optionally only for a
    piece of the polyline (see "piecesOf"), whose corners keep the
    rounding of the whole polyline, as far as its cut segments hold it  */
export const pathOf = (poly: Poly, hop: Map<number, number[]>, rounding: number, hopRadius: number,
    junction?: (x: number, y: number) => boolean, bridges = false, piece?: Piece): string => {
    const radius = (k: number): number => {
        if (k <= 0 || k >= poly.length - 1 || junction?.(poly[k][0], poly[k][1]))
            return 0
        let r = Math.min(rounding, len(poly[k - 1], poly[k]) / 2, len(poly[k], poly[k + 1]) / 2)

        /*  shrink the corner rounding when a crossing hop sits close
            to the bend, so the hop is never swallowed by the arc  */
        for (const seg of [ k - 1, k ])
            for (const hx of hop.get(seg) ?? [])
                r = Math.min(r, Math.max(Math.abs(hx - poly[k][0]) - hopRadius - 2, 4))
        return r
    }

    /*  the rounding of the corners of the drawn points (the ends of a
        piece stay sharp, and its corners next to a cut segment are
        rounded at most along the part of that segment it keeps)  */
    const pts    = piece?.poly ?? poly
    const from   = piece?.from ?? 0
    const corner = (j: number): number =>
        j <= 0 || j >= pts.length - 1 ? 0 :
            Math.min(radius(from + j), len(pts[j - 1], pts[j]), len(pts[j], pts[j + 1]))
    const d: string[] = []
    for (let j = 0; j < pts.length - 1; j++) {
        const k   = from + j
        const [ a, b ] = [ pts[j], pts[j + 1] ]
        const l   = len(a, b)
        const ux  = (b[0] - a[0]) / l
        const uy  = (b[1] - a[1]) / l
        const r0  = corner(j)
        const r1  = corner(j + 1)
        const p0: [ number, number ] = [ a[0] + ux * r0, a[1] + uy * r0 ]
        const p1: [ number, number ] = [ b[0] - ux * r1, b[1] - uy * r1 ]
        if (j === 0)
            d.push(`M ${p0[0]} ${p0[1]}`)
        if (a[1] === b[1] && hop.has(k)) {
            const dir = Math.sign(b[0] - a[0])
            const xs  = hop.get(k)!
                .filter((hx) => (hx - p0[0]) * dir > 2 && (p1[0] - hx) * dir > 2)
                .sort((m, n) => (m - n) * dir)

            /*  merge closely adjacent crossings into groups, each
                rendered as one single wide "long hop" arc (crossings
                are merged whenever the flat line piece left between
                their individual hops would be shorter than 14px), or,
                with bridges, as one flat bridge, rising before the first
                crossing and descending after the last one (crossings
                are merged whenever the flat line piece left between
                their individual hops would be shorter than two hops)  */
            const merge  = bridges ? hopRadius * 6 : hopRadius * 2 + 14
            const groups: number[][] = []
            for (const hx of xs) {
                const g = groups.at(-1)
                if (g !== undefined && Math.abs(hx - g.at(-1)!) <= merge)
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
                const sweep = dir > 0 ? 1 : 0
                const rise  = Math.min(hopRadius, Math.abs(x2 - x1) / 2)
                if (bridges && g.length > 1) {
                    d.push(`A ${rise} ${hopRadius} 0 0 ${sweep} ${x1 + dir * rise} ${a[1] - hopRadius}`)
                    d.push(`L ${x2 - dir * rise} ${a[1] - hopRadius}`)
                    d.push(`A ${rise} ${hopRadius} 0 0 ${sweep} ${x2} ${a[1]}`)
                }
                else
                    d.push(`A ${Math.abs(x2 - x1) / 2} ${hopRadius} 0 0 ${sweep} ${x2} ${a[1]}`)
            }
        }
        d.push(`L ${p1[0]} ${p1[1]}`)
        if (j < pts.length - 2) {
            const c  = pts[j + 1]
            const n  = pts[j + 2]
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

