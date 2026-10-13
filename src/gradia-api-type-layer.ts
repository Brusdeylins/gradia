/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge, Graph }        from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, FS_GROUP, ASC, textWidth }
    from "./gradia-api-render-base.js"
import { Shape, textShape, legendShapes }
    from "./gradia-api-render-shape.js"
import { LevelContext, boundsOf }   from "./gradia-api-render-container.js"
import { parentOf, containerTypeOf }
    from "./gradia-api-render-node.js"
import { render as renderGraph }    from "./gradia-api-type-graph.js"

/*  the gap between two neighboring layer bands, and the margin of a
    band around its node boxes  */
const BAND_GAP    = 8
const BAND_MARGIN = 20

/*  the special "layer" annotation (the name of the layer of a node)  */
const layerOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "layer")?.val

/*  the special "layer-group" annotation (the "/"-separated path of the
    nested groups the layer of a node belongs to, outermost first)  */
const groupsOf = (node: Node): string[] =>
    (node.attrs.findLast((attr) => attr.key === "layer-group")?.val ?? "")
        .split("/").map((name) => name.trim()).filter((name) => name !== "")

/*  the geometry of the layer groups, the layer numbers, and the legend  */
const GROUP_W    = 40   /*  width of a group column              */
const GROUP_GAP  = 8    /*  gap between the group columns        */
const NUMBER_R   = 13   /*  radius of the circle of a number     */
const LEGEND_GAP = 24   /*  gap between the bands and the legend  */

/*  lay out a graph model as a layered architecture: the layers, in the
    order of their first appearance, become horizontal bands stacked
    top-down, each holding its nodes (laid out as an explicitly ordered
    "graph", one row per layer, wrapped beyond "graph-columns-max"
    nodes, the nodes without a layer trailing outside of any band), and
    an edge from a lower layer to a higher one, i.e. pointing upwards
    against the layering, is marked as a violation  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph carries no containers, as the bands are the
        only nesting of a layered diagram  */
    const nodes = Array.from(graph.nodes.values())
    if ((level.fixedSize?.size ?? 0) > 0
        || nodes.some((node) => parentOf(node) !== undefined || containerTypeOf(node) !== undefined))
        throw new Error("diagram type \"layer\" does not support containers")

    /*  determine the layers in the order of their first appearance, with
        the layers of a group kept together (at the position of the first
        appearance of the group, on every nesting level), and lay out
        every layer as one explicitly ordered row of a "graph"  */
    const pathOf = new Map<string, string[]>()
    for (const node of nodes) {
        const layer = layerOf(node)
        if (layer === undefined)
            continue
        const path = pathOf.get(layer)
        if (path === undefined)
            pathOf.set(layer, groupsOf(node))
        else if (path.join("/") !== groupsOf(node).join("/"))
            throw new Error(`node "${node.id}" places layer "${layer}" into group ` +
                `"${groupsOf(node).join("/")}", unlike group "${path.join("/")}" of its other nodes`)
    }
    const firstOf = new Map<string, number>()
    Array.from(pathOf.entries()).forEach(([ layer, path ], i) => {
        const keys = [ ...path.map((_, k) => path.slice(0, k + 1).join("/")), `${path.join("/")}//${layer}` ]
        for (const key of keys)
            if (!firstOf.has(key))
                firstOf.set(key, i)
    })
    const rankOf = (layer: string): number[] => {
        const path = pathOf.get(layer)!
        return [ ...path.map((_, k) => firstOf.get(path.slice(0, k + 1).join("/"))!),
            firstOf.get(`${path.join("/")}//${layer}`)! ]
    }
    const layers = Array.from(pathOf.keys()).sort((a, b) => {
        const [ ra, rb ] = [ rankOf(a), rankOf(b) ]
        for (let k = 0; k < Math.min(ra.length, rb.length); k++)
            if (ra[k] !== rb[k])
                return ra[k] - rb[k]
        return ra.length - rb.length
    })
    const index  = new Map(layers.map((name, i) => [ name, i ]))
    const indexOf = (id: string): number | undefined => {
        const node = graph.nodes.get(id)
        const name = node !== undefined ? layerOf(node) : undefined
        return name !== undefined ? index.get(name) : undefined
    }
    const ordered: Graph = {
        nodes: new Map(nodes.map((node) => [ node.id, {
            ...node,
            attrs: [ ...node.attrs.filter((attr) => ![ "layer", "layer-group", "order" ].includes(attr.key)),
                ...(layerOf(node) !== undefined ? [ { key: "order", val: String(index.get(layerOf(node)!)) } ] : []) ]
        } ])),
        edges: graph.edges
    }

    /*  lay out the graph with uniformly sized boxes: every box takes the
        width of the widest box of the diagram and the height of the
        highest box of its layer, so the boxes form a regular raster, the
        columns line up across the layers, and the names of a layer share
        one baseline, and the gutters between the layers take one height,
        so the bands are evenly spaced, where the gutters have to hold the
        margins of the two bands beside them plus the gap between them  */
    const cfg    = { ...config, "graph-gutter-height-min":
        Math.max(config["graph-gutter-height-min"], BAND_MARGIN * 2 + BAND_GAP) }
    const layout = await renderGraph(ordered, cfg, level, { laneOf: (id) => indexOf(id) ?? -1 })

    /*  determine the vertical extent of every layer from its node boxes  */
    const pad    = config["group-box-padding"]
    const top    = layers.map(() => Infinity)
    const bottom = layers.map(() => -Infinity)
    for (const node of layout.nodes) {
        const i = indexOf(node.id)
        if (i === undefined)
            continue
        const h = layout.boxH.get(node.id)! / 2
        top[i]    = Math.min(top[i],    layout.cy(node.id) - h)
        bottom[i] = Math.max(bottom[i], layout.cy(node.id) + h)
    }

    /*  draw every layer as a band spanning the whole diagram, its nodes
        vertically centered by the same margin above and below them, with
        the layer name left of its nodes in the bold font of the group
        tags, below the edges and the nodes  */
    const bounds   = boundsOf(layout)
    const numbered = config["layer-numbered"]
    const numberW  = numbered ? NUMBER_R * 2 + 12 : 0
    const labelW   = layers.reduce((w, name) => Math.max(w, textWidth(name, FS_GROUP, true)), 0) + numberW
    const left     = bounds.minX - pad - labelW - pad
    const right    = bounds.maxX + pad
    const shapes: Shape[] = []
    const y1Of = (i: number) => top[i]    - BAND_MARGIN
    const y2Of = (i: number) => bottom[i] + BAND_MARGIN
    layers.forEach((name, i) => {
        if (!Number.isFinite(top[i]))
            return
        const [ y1, y2 ] = [ y1Of(i), y2Of(i) ]
        const mid = (y1 + y2) / 2
        shapes.push({ kind: "rect", x: left, y: y1, w: right - left, h: y2 - y1, rx: 12,
            fill: "color-container-box", stroke: "color-container-border", width: 2 })
        if (numbered) {
            shapes.push({ kind: "rect", x: left + pad, y: mid - NUMBER_R, w: NUMBER_R * 2, h: NUMBER_R * 2,
                rx: NUMBER_R, fill: "color-container-box", stroke: "color-container-name", width: 2 })
            shapes.push(textShape(left + pad + NUMBER_R, mid + config["size-font-type"] * ASC, String(i + 1),
                "color-container-name", "size-font-type", config, { anchor: "middle", bold: true }))
        }
        shapes.push(textShape(left + pad + numberW, mid + FS_GROUP * ASC, name,
            "color-container-name", FS_GROUP, config, { bold: true }))
    })

    /*  draw every group of layers as a column left of the bands, nested
        groups further right, spanning the bands of its layers, with its
        name running upwards  */
    const depth = layers.reduce((d, layer) => Math.max(d, pathOf.get(layer)!.length), 0)
    for (let k = 0; k < depth; k++) {
        const x = left - (depth - k) * (GROUP_W + GROUP_GAP)
        let start = 0
        while (start < layers.length) {
            const path = pathOf.get(layers[start])!
            if (path.length <= k) {
                start++
                continue
            }
            const key = path.slice(0, k + 1).join("/")
            let end = start
            while (end + 1 < layers.length && pathOf.get(layers[end + 1])!.slice(0, k + 1).join("/") === key)
                end++
            const [ y1, y2 ] = [ y1Of(start), y2Of(end) ]
            shapes.push({ kind: "rect", x, y: y1, w: GROUP_W, h: y2 - y1, rx: 12,
                fill: "color-container-box", stroke: "color-container-border", width: 2 })
            shapes.push(textShape(x + GROUP_W / 2 + FS_GROUP * ASC, (y1 + y2) / 2, path[k],
                "color-container-name", FS_GROUP, config, { anchor: "middle", bold: true, upright: true }))
            start = end + 1
        }
    }

    /*  an edge pointing from a lower layer to a higher one violates the
        layering (an edge within a layer or towards a lower one is fine)  */
    const violates = (edge: Edge): boolean => {
        const [ s, t ] = [ indexOf(edge.source), indexOf(edge.target) ]
        return s !== undefined && t !== undefined && s > t
    }

    /*  explain a visible violation in a legend below the bands  */
    const marked = layout.edges.map((edge) => violates(edge))
    if (marked.includes(true)) {
        const below = bottom.reduce((y, b) => Number.isFinite(b) ? Math.max(y, b) : y, bounds.maxY)
        shapes.push(...legendShapes([ { swatch: "line", color: "color-mark-violation",
            text: config["legend-upward"] } ], left - depth * (GROUP_W + GROUP_GAP), below + BAND_MARGIN + LEGEND_GAP, config))
    }
    return { ...layout, shapes: [ ...(layout.shapes ?? []), ...shapes ], marked }
}
