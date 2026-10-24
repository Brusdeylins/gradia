/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Graph }                         from "./gradia-api-model.js"
import { Config }                              from "./gradia-api-config.js"
import { Poly, FS_GROUP, textWidth, Layout, GroupBox, ContainerBox }
    from "./gradia-api-render-base.js"
import { defaultStyleOf }                      from "./gradia-api-render-node.js"
import { Containment, rootOf, boundsOf }       from "./gradia-api-render-container.js"

/*  rendering geometry constants  */
const GROUP_HEAD = 34  /*  extra top space for the group tag  */

/*  the special "group" annotation (assigning a node to a named group)  */
export const groupOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "group")?.val

/*  a partition of the graph: one named group and its subgraph  */
export interface GroupPart {
    name:  string
    graph: Graph
}

/*  partition the graph into its named groups (in order of first
    appearance), implying "group: default" for the nodes without one,
    or return null when no node uses a group at all. A nested node
    belongs to the group of its outermost container, so reject any
    deviating group of its own. Edges have to stay within a single
    group, so reject any group-crossing edge  */
export const partitionGroups = (graph: Graph, containment: Containment): GroupPart[] | null => {
    /*  short-circuit when no node uses a group at all  */
    const nodes = Array.from(graph.nodes.values())
    if (!nodes.some((node) => groupOf(node) !== undefined))
        return null

    /*  assign every node to the group of its outermost container  */
    const parts  = new Map<string, Graph>()
    const nameOf = new Map<string, string>()
    for (const node of nodes) {
        const root = rootOf(containment, node.id)
        const name = groupOf(graph.nodes.get(root)!) ?? "default"
        const own  = groupOf(node)
        if (own !== undefined && own !== name)
            throw new Error(`node "${node.id}" cannot be a member of group "${own}", ` +
                `as its container "${root}" is a member of group "${name}"`)
        nameOf.set(node.id, name)
        let part = parts.get(name)
        if (part === undefined) {
            part = { nodes: new Map(), edges: [] }
            parts.set(name, part)
        }
        part.nodes.set(node.id, node)
    }

    /*  assign every edge to the common group of its endpoints  */
    for (const edge of graph.edges) {
        const sg = nameOf.get(edge.source)!
        const tg = nameOf.get(edge.target)!
        if (sg !== tg)
            throw new Error(`edge "${edge.source}" --> "${edge.target}" ` +
                `crosses groups "${sg}" and "${tg}"`)
        parts.get(sg)!.edges.push(edge)
    }

    /*  provide the partitions in order of first appearance  */
    return Array.from(parts.entries()).map(([ name, subgraph ]) => ({ name, graph: subgraph }))
}

/*  compose the per-group layouts into a single layout: the groups are
    stacked vertically, each one shifted into its surrounding group box
    (a node id is unique across the groups, as every node is a member
    of exactly one group, so the maps can be merged and the coordinate
    functions can dispatch on the node id)  */
export const composeGroups = (parts: GroupPart[], layouts: Layout[], config: Config): Layout => {
    /*  resolve the configurable rendering geometry  */
    const margin = config["size-canvas-margin"]
    const pad    = config["group-box-padding"]
    const gap    = config["group-box-gap"]

    /*  stack the group boxes vertically and determine the coordinate
        offset which shifts each layout into its group box  */
    const groups: GroupBox[] = []
    const dxs:    number[]   = []
    const dys:    number[]   = []
    const groupIdx           = new Map<string, number>()
    let y = margin
    layouts.forEach((layout, i) => {
        const b = boundsOf(layout)
        const w = Math.max(b.maxX - b.minX + pad * 2,
            textWidth(parts[i].name, FS_GROUP) + pad * 2)
        const h = b.maxY - b.minY + pad * 2 + GROUP_HEAD
        dxs.push(margin + pad - b.minX)
        dys.push(y + GROUP_HEAD + pad - b.minY)
        for (const node of layout.nodes)
            groupIdx.set(node.id, i)
        groups.push({ name: parts[i].name, x: margin, y, w, h })
        y += h + gap
    })

    /*  merge the per-group layouts into the composed layout  */
    const merge = (pick: (layout: Layout) => Map<string, number>): Map<string, number> =>
        new Map(layouts.flatMap((layout) => Array.from(pick(layout).entries())))
    const groupIdxOf = (id: string) => groupIdx.get(id)!
    return {
        nodes:      layouts.flatMap((layout) => layout.nodes),
        edges:      layouts.flatMap((layout) => layout.edges),
        cx:         (id) => layouts[groupIdxOf(id)].cx(id) + dxs[groupIdxOf(id)],
        cy:         (id) => layouts[groupIdxOf(id)].cy(id) + dys[groupIdxOf(id)],
        boxW:       merge((layout) => layout.boxW),
        boxH:       merge((layout) => layout.boxH),
        contentH:   merge((layout) => layout.contentH),
        polys:      layouts.flatMap((layout, i) => layout.polys.map((poly): Poly =>
            poly.map(([ px, py ]) => [ px + dxs[i], py + dys[i] ]))),
        styleOf:    (node) => (layouts[groupIdxOf(node.id)].styleOf ?? defaultStyleOf)(node),
        groups,
        containers: layouts.flatMap((layout, i) => (layout.containers ?? []).map((c): ContainerBox =>
            ({ ...c, x: c.x + dxs[i], y: c.y + dys[i] }))),
        bundled:    layouts.flatMap((layout) => layout.edges.map((_, i) => layout.bundled?.[i] ?? false))
    }
}

