/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge, Graph }                       from "./gradia-api-model.js"
import { Config }                                  from "./gradia-api-config.js"
import { Poly, FS_GROUP, textWidth, Layout, ContainerBox, shapeBox, shiftShape }
    from "./gradia-api-render-base.js"
import { parentOf, containerTypeOf, containerHead, typeOf, defaultStyleOf }
    from "./gradia-api-render-node.js"
import { simplifyPoly }                            from "./gradia-api-render-edge.js"

/*  the side of a container boundary a gate node sits on: an "in" gate
    on the west side carries an edge entering the container, an "out"
    gate on the east side an edge leaving it  */
export type GateSide = "in" | "out"

/*  the context a diagram type renderer lays out a single containment
    level with: the fixed box sizes of the container placeholders and
    the (zero-sized) gate nodes, the vertical port offsets (from the box
    center) fixed for the edge ends attaching to a container placeholder
    at the position of its inner gate, and the gate nodes themselves  */
export interface LevelContext {
    fixedSize?: Map<string, { w: number, h: number }>
    fixedPort?: (edge: number, role: "s" | "t") => number | undefined
    gates?:     Map<string, GateSide>
}

/*  a diagram type renderer  */
export type Renderer = (graph: Graph, config: Config, level?: LevelContext) => Promise<Layout>

/*  a diagram type: its renderer, whether it lays out the members of a
    container (and hence is valid as a "container" annotation), and
    whether it supports gate nodes (and hence lets the edges crossing a
    container boundary continue to the inner nodes, instead of ending at
    the container border)  */
export interface DiagramTypeSpec {
    render:   Renderer
    nestable: boolean
    gated:    boolean
}

/*  the containment tree of a graph  */
export interface Containment {
    parentOf:   Map<string, string>
    childrenOf: Map<string, Node[]>
}

/*  determine the containment tree of the graph (in order of node
    appearance) and validate it: every "parent" has to be a declared
    node, no node may be nested into itself, no edge may connect a
    container with one of its own members, and every "container"
    annotation has to name a diagram type laying out container members  */
export const containmentOf = (graph: Graph, types: string[]): Containment => {
    /*  collect the parent/children relations of the nodes  */
    const parentOfId = new Map<string, string>()
    const childrenOf = new Map<string, Node[]>()
    for (const node of graph.nodes.values()) {
        const type = containerTypeOf(node)
        if (type !== undefined && !types.includes(type))
            throw new Error(`invalid container layout type "${type}" of node "${node.id}" ` +
                `(expected one of ${types.map((t) => `"${t}"`).join(", ")})`)
        const parent = parentOf(node)
        if (parent === undefined)
            continue
        if (!graph.nodes.has(parent))
            throw new Error(`container "${parent}" of node "${node.id}" is not a declared node`)
        parentOfId.set(node.id, parent)
        const children = childrenOf.get(parent)
        if (children === undefined)
            childrenOf.set(parent, [ node ])
        else
            children.push(node)
    }

    /*  reject the containment cycles  */
    for (const id of parentOfId.keys()) {
        const seen = new Set<string>([ id ])
        for (let p = parentOfId.get(id); p !== undefined; p = parentOfId.get(p)) {
            if (seen.has(p))
                throw new Error(`node "${id}" cannot be nested into itself (containment cycle)`)
            seen.add(p)
        }
    }

    /*  reject the edges connecting a container with one of its own members  */
    const isAncestor = (a: string, id: string): boolean => {
        for (let p = parentOfId.get(id); p !== undefined; p = parentOfId.get(p))
            if (p === a)
                return true
        return false
    }
    for (const edge of graph.edges)
        if (isAncestor(edge.source, edge.target) || isAncestor(edge.target, edge.source))
            throw new Error(`edge "${edge.source}" --> "${edge.target}" ` +
                "connects a container with one of its own members")
    return { parentOf: parentOfId, childrenOf }
}

/*  the outermost container of a node (the node itself if not nested)  */
export const rootOf = (containment: Containment, id: string): string => {
    let root = id
    for (let p = containment.parentOf.get(root); p !== undefined; p = containment.parentOf.get(root))
        root = p
    return root
}

/*  a rectangular bounding box  */
export interface Bounds {
    minX: number
    minY: number
    maxX: number
    maxY: number
}

/*  determine the bounding box of a laid out graph (its nodes, edges,
    container boxes, and the additionally given polylines)  */
export const boundsOf = (layout: Layout, extra: Poly[] = []): Bounds => {
    const { nodes, cx, cy, boxW, boxH, polys } = layout
    let [ minX, minY, maxX, maxY ] = [ Infinity, Infinity, -Infinity, -Infinity ]
    for (const node of nodes) {
        minX = Math.min(minX, cx(node.id) - boxW.get(node.id)! / 2)
        minY = Math.min(minY, cy(node.id) - boxH.get(node.id)! / 2)
        maxX = Math.max(maxX, cx(node.id) + boxW.get(node.id)! / 2)
        maxY = Math.max(maxY, cy(node.id) + boxH.get(node.id)! / 2)
    }
    for (const poly of [ ...polys, ...extra ]) {
        for (const [ px, py ] of poly) {
            minX = Math.min(minX, px)
            minY = Math.min(minY, py)
            maxX = Math.max(maxX, px)
            maxY = Math.max(maxY, py)
        }
    }
    for (const shape of layout.shapes ?? []) {
        const [ x1, y1, x2, y2 ] = shapeBox(shape)
        minX = Math.min(minX, x1)
        minY = Math.min(minY, y1)
        maxX = Math.max(maxX, x2)
        maxY = Math.max(maxY, y2)
    }
    for (const c of layout.containers ?? []) {
        minX = Math.min(minX, c.x)
        minY = Math.min(minY, c.y)
        maxX = Math.max(maxX, c.x + c.w)
        maxY = Math.max(maxY, c.y + c.h)
    }
    if (!Number.isFinite(minX))
        [ minX, minY, maxX, maxY ] = [ 0, 0, 0, 0 ]
    return { minX, minY, maxX, maxY }
}

/*  the id of the gate node carrying the given edge across a container
    boundary (the control character keeps it apart from all user ids)  */
const gateId = (edge: number, side: GateSide): string =>
    `\u0000gate:${edge}:${side}`

/*  the result of laying out one containment level: the composed layout
    of the level and all its nested levels (in the coordinates of the
    level), its bounding box, and the partial routes of the edges
    crossing the boundary of the level, from the gate on the boundary
    to the inner node (keyed by the index of the edge in the graph)  */
interface Level {
    layout:  Layout
    bounds:  Bounds
    partial: Map<number, Poly>
}

/*  lay out a graph model with its container nodes: each container is
    laid out as a containment level of its own (innermost first, with the
    diagram type of the enclosing level unless annotated otherwise), and
    then takes part in the layout of its enclosing level as a placeholder
    node of the size of its box. An edge crossing a container boundary
    is lifted to the level where both its endpoints (or the containers
    holding them) are members, while inside every crossed container (of
    a gated diagram type) it continues from a gate node on the boundary
    to the inner node. The partial routes are finally stitched into
    the complete route of the edge  */
export const renderContained = async (
    graph:       Graph,
    containment: Containment,
    type:        string,
    types:       Record<string, DiagramTypeSpec>,
    config:      Config
): Promise<Layout> => {
    const nodes = Array.from(graph.nodes.values())
    const isContainer = (node: Node): boolean =>
        containment.childrenOf.has(node.id) || containerTypeOf(node) !== undefined

    /*  short-cut the plain case of a graph without any container  */
    if (!nodes.some(isContainer))
        return types[type].render(graph, config)
    const pad = config["container-box-padding"]

    /*  reject the node ids which could collide with the gate node ids  */
    for (const node of nodes)
        if (node.id.includes("\u0000"))
            throw new Error(`node id ${JSON.stringify(node.id)} contains a reserved control character`)

    /*  the box size of a container placeholder: its content plus
        the padding and the head, at least as wide as its tag  */
    const sizeOf = (member: Node, b: Bounds): { w: number, h: number } => {
        const tag = Math.max(textWidth(member.name, FS_GROUP),
            textWidth(typeOf(member) ?? "", config["size-font-type"]))
        return {
            w: Math.max(b.maxX - b.minX, tag) + pad * 2,
            h: b.maxY - b.minY + pad * 2 + containerHead(member, config)
        }
    }

    /*  compose a laid out containment level with its inner levels: the
        inner layouts are shifted into their container boxes, the edges
        of the level are stitched together with the partial routes
        inside the containers they leave or enter, and the placeholders
        and gates are dropped (the container boxes are rendered in
        their place)  */
    const composeLevel = (
        layout:     Layout,
        inner:      Map<string, Level>,
        levelEdges: Edge[],
        origin:     number[],
        gates:      Map<string, GateSide>,
        type:       string
    ): Level => {
        /*  shift every inner layout into its container box (the parts
            are the level layout itself and the shifted inner layouts,
            with every node id dispatching to the part it belongs to)  */
        const parts: { layout: Layout, dx: number, dy: number }[] = [ { layout, dx: 0, dy: 0 } ]
        const partOf = new Map<string, number>()
        for (const node of layout.nodes)
            partOf.set(node.id, 0)
        const boxes:      ContainerBox[] = []
        const innerBoxes: ContainerBox[] = []
        const placed = new Set(layout.nodes.map((node) => node.id))
        for (const [ id, level ] of inner) {
            const member = graph.nodes.get(id)!
            if (!placed.has(id))
                throw new Error(`container "${id}" cannot be placed twice by diagram type "${type}"`)
            const { w, h } = sizeOf(member, level.bounds)
            const cx = layout.cx(id)
            const cy = layout.cy(id)
            const k  = parts.push({
                layout: level.layout,
                dx:     cx - w / 2 + pad - level.bounds.minX,
                dy:     cy - h / 2 + containerHead(member, config) + pad - level.bounds.minY
            }) - 1
            for (const node of level.layout.nodes)
                partOf.set(node.id, k)
            partOf.set(id, k)
            boxes.push({
                node: member,
                x:    cx - layout.boxW.get(id)! / 2,
                y:    cy - layout.boxH.get(id)! / 2,
                w:    layout.boxW.get(id)!,
                h:    layout.boxH.get(id)!
            })
            innerBoxes.push(...(level.layout.containers ?? []).map((c): ContainerBox =>
                ({ ...c, x: c.x + parts[k].dx, y: c.y + parts[k].dy })))
        }
        const shift = (poly: Poly, k: number): Poly =>
            poly.map(([ px, py ]) => [ px + parts[k].dx, py + parts[k].dy ])

        /*  collect the edges completed within the inner levels, then
            the edges of this level, each stitched together with the
            partial routes inside the containers it leaves or enters
            (an edge crossing the boundary of this level stays partial)  */
        const edges:   Edge[]    = []
        const polys:   Poly[]    = []
        const marked:  boolean[] = []
        const bundled: boolean[] = []
        const partial            = new Map<number, Poly>()
        parts.forEach((part, k) => {
            if (k === 0)
                return
            part.layout.edges.forEach((edge, ei) => {
                edges.push(edge)
                polys.push(shift(part.layout.polys[ei], k))
                marked.push(part.layout.marked?.[ei] ?? false)
                bundled.push(part.layout.bundled?.[ei] ?? false)
            })
        })
        levelEdges.forEach((edge, li) => {
            const i    = origin[li]
            const head = inner.get(edge.source)?.partial.get(i)
            const tail = inner.get(edge.target)?.partial.get(i)
            const poly = simplifyPoly([
                ...(head !== undefined ? shift(head, partOf.get(edge.source)!) : []),
                ...layout.polys[li],
                ...(tail !== undefined ? shift(tail, partOf.get(edge.target)!) : [])
            ])
            if (gates.has(edge.source) || gates.has(edge.target))
                partial.set(i, poly)
            else {
                edges.push(graph.edges[i])
                polys.push(poly)
                marked.push(layout.marked?.[li] ?? false)
                bundled.push(layout.bundled?.[li] ?? false)
            }
        })

        /*  compose the level (the placeholders and gates are dropped,
            as the container boxes are rendered in their place)  */
        const merge = (pick: (layout: Layout) => Map<string, number>): Map<string, number> =>
            new Map(parts.flatMap((part) => Array.from(pick(part.layout).entries())))
        const composed: Layout = {
            nodes: [
                ...layout.nodes.filter((node) => !inner.has(node.id) && !gates.has(node.id)),
                ...parts.slice(1).flatMap((part) => part.layout.nodes)
            ],
            edges,
            cx:         (id) => parts[partOf.get(id)!].layout.cx(id) + parts[partOf.get(id)!].dx,
            cy:         (id) => parts[partOf.get(id)!].layout.cy(id) + parts[partOf.get(id)!].dy,
            boxW:       merge((layout) => layout.boxW),
            boxH:       merge((layout) => layout.boxH),
            contentH:   merge((layout) => layout.contentH),
            polys,
            styleOf:    (node) => (parts[partOf.get(node.id)!].layout.styleOf ?? defaultStyleOf)(node),
            containers: [ ...boxes, ...innerBoxes ],
            shapes:     parts.flatMap((part) => (part.layout.shapes ?? []).map((shape) =>
                shiftShape(shape, part.dx, part.dy))),
            marked,
            bundled,
            junctions:  parts.flatMap((part, k) => shift(part.layout.junctions ?? [], k)),
            crowded:    parts.some((part) => part.layout.crowded === true)
        }
        return { layout: composed, bounds: boundsOf(composed, Array.from(partial.values())), partial }
    }

    /*  lay out a single containment level  */
    const layoutLevel = async (container: Node | null, type: string): Promise<Level> => {
        const members = container === null ?
            nodes.filter((node) => parentOf(node) === undefined) :
            containment.childrenOf.get(container.id) ?? []
        const memberIds = new Set(members.map((member) => member.id))

        /*  the member of this level a node of its subtree belongs to  */
        const topOf = (id: string): string | undefined => {
            for (let cur: string | undefined = id; cur !== undefined; cur = containment.parentOf.get(cur))
                if (memberIds.has(cur))
                    return cur
            return undefined
        }

        /*  lay out the member containers first  */
        const inner = new Map<string, Level>()
        for (const member of members)
            if (isContainer(member))
                inner.set(member.id, await layoutLevel(member, containerTypeOf(member) ?? type))

        /*  the vertical offset (from the placeholder center) of the
            port an edge crossing the boundary of a member container
            attaches at: the position of its inner gate  */
        const portOffset = (member: Node, y: number): number => {
            const { bounds } = inner.get(member.id)!
            return (y - bounds.minY) + containerHead(member, config) + pad - sizeOf(member, bounds).h / 2
        }

        /*  derive the edges of this level: the edges lifted to it (both
            endpoints in the subtree, but not both inside the same member
            container), and, for a gated diagram type, the edges crossing
            its own boundary, continued from a gate node. The name of an
            edge is placed at its lifted level, its arity at the level
            holding its arrow head  */
        const gates                = new Map<string, GateSide>()
        const levelNodes           = new Map<string, Node>(members.map((member) => [ member.id, member ]))
        const levelEdges: Edge[]   = []
        const origin:     number[] = []
        const fixedPort            = new Map<string, number>()
        const continues            = (id: string, edge: number): boolean =>
            inner.get(id)?.partial.has(edge) ?? false
        graph.edges.forEach((edge, i) => {
            const ts = topOf(edge.source)
            const tt = topOf(edge.target)
            if (ts === undefined && tt === undefined)
                return
            if (ts !== undefined && ts === tt && inner.has(ts) && edge.source !== ts)
                return
            let source: string
            let target: string
            if (ts === undefined || tt === undefined) {
                if (!types[type].gated)
                    return
                const gate = gateId(i, ts === undefined ? "in" : "out")
                gates.set(gate, ts === undefined ? "in" : "out")
                levelNodes.set(gate, { id: gate, name: "", attrs: [] })
                source = ts ?? gate
                target = tt ?? gate
            }
            else {
                source = ts
                target = tt
            }
            const li = levelEdges.length
            levelEdges.push({
                source,
                target,
                name:  ts !== undefined && tt !== undefined ? edge.name : undefined,
                arity: tt !== undefined && !continues(tt, i) ? edge.arity : undefined
            })
            origin.push(i)
            if (continues(source, i))
                fixedPort.set(`${li}:s`, portOffset(levelNodes.get(source)!,
                    inner.get(source)!.partial.get(i)!.at(-1)![1]))
            if (continues(target, i))
                fixedPort.set(`${li}:t`, portOffset(levelNodes.get(target)!,
                    inner.get(target)!.partial.get(i)![0][1]))
        })

        /*  lay out the level with the member containers as placeholders  */
        const fixedSize = new Map<string, { w: number, h: number }>()
        for (const [ id, level ] of inner)
            fixedSize.set(id, sizeOf(levelNodes.get(id)!, level.bounds))
        for (const gate of gates.keys())
            fixedSize.set(gate, { w: 0, h: 0 })
        const layout = await types[type].render({ nodes: levelNodes, edges: levelEdges }, config, {
            fixedSize,
            fixedPort: (edge, role) => fixedPort.get(`${edge}:${role}`),
            gates
        })
        return composeLevel(layout, inner, levelEdges, origin, gates, type)
    }
    return (await layoutLevel(null, type)).layout
}

