/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge, Graph }        from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, Shape, FS_GROUP, onRaster, textShape, textWidth, legendShapes }
    from "./gradia-api-render-base.js"
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

/*  the geometry of the layer groups and the layer numbers  */
const GROUP_W   = 40   /*  width of a group column            */
const GROUP_GAP = 8    /*  gap between the group columns      */
const NUMBER_R  = 13   /*  radius of the circle of a number   */

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
        if (layer !== undefined && !pathOf.has(layer))
            pathOf.set(layer, groupsOf(node))
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
        const name = layerOf(graph.nodes.get(id)!)
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

    /*  lay out the graph twice: first freely, to learn the box sizes the
        texts and the edge ports demand, and then with every box fixed to
        the raster-rounded width of the widest box of the diagram and the
        height of the highest box of its layer, so the boxes form a
        regular raster, the columns line up across the layers, and the
        names of a layer share one baseline (the text keeping its own
        content height, so it stays vertically centered)  */
    /*  the gutters between the layers have to hold the margins of the
        two bands beside them plus the gap between the bands  */
    const cfg    = { ...config, "graph-gutter-height-min":
        Math.max(config["graph-gutter-height-min"], BAND_MARGIN * 2 + BAND_GAP) }
    const free   = await renderGraph(ordered, cfg, level)
    const width  = onRaster(free.nodes.reduce((w, node) => Math.max(w, free.boxW.get(node.id)!), 0))
    const height = new Map<number | undefined, number>()
    for (const node of free.nodes) {
        const i = indexOf(node.id)
        height.set(i, Math.max(height.get(i) ?? 0, onRaster(free.boxH.get(node.id)!)))
    }
    const fixedSize = new Map(free.nodes.map((node) =>
        [ node.id, { w: width, h: height.get(indexOf(node.id))! } ]))

    /*  unify the gutters between the layers onto the raster-rounded
        height of the highest one, so the bands are evenly spaced  */
    const extent = (layout: Layout, i: number, edge: "top" | "bottom") =>
        layout.nodes.filter((node) => indexOf(node.id) === i).reduce((y, node) => edge === "top" ?
            Math.min(y, layout.cy(node.id) - layout.boxH.get(node.id)! / 2) :
            Math.max(y, layout.cy(node.id) + layout.boxH.get(node.id)! / 2), edge === "top" ? Infinity : -Infinity)
    let gutter = cfg["graph-gutter-height-min"]
    for (let i = 0; i < layers.length - 1; i++) {
        const gap = extent(free, i + 1, "top") - extent(free, i, "bottom")
        if (Number.isFinite(gap))
            gutter = Math.max(gutter, gap)
    }
    const layout = await renderGraph(ordered, { ...cfg, "graph-gutter-height-min": onRaster(gutter) },
        { ...level, fixedSize })
    layout.contentH = free.contentH

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
    const labelW   = layers.reduce((w, name) => Math.max(w, textWidth(name, FS_GROUP)), 0) + numberW
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
            fill: "color-group-box", stroke: "color-group-border", width: 3 })
        if (numbered) {
            shapes.push({ kind: "rect", x: left + pad, y: mid - NUMBER_R, w: NUMBER_R * 2, h: NUMBER_R * 2,
                rx: NUMBER_R, fill: "color-group-box", stroke: "color-group-name", width: 2 })
            shapes.push(textShape(left + pad + NUMBER_R, mid + config["size-font-type"] * 0.36, String(i + 1),
                "color-group-name", "size-font-type", config, "middle", true))
        }
        shapes.push(textShape(left + pad + numberW, mid + FS_GROUP * 0.36, name,
            "color-group-name", FS_GROUP, config, "start", true))
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
                fill: "color-group-box", stroke: "color-group-border", width: 3 })
            shapes.push(textShape(x + GROUP_W / 2 + FS_GROUP * 0.36, (y1 + y2) / 2, path[k],
                "color-group-name", FS_GROUP, config, "middle", true, undefined, true))
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
    if (graph.edges.some((edge) => violates(edge))) {
        const below = bottom.reduce((y, b) => Number.isFinite(b) ? Math.max(y, b) : y, bounds.maxY)
        shapes.push(...legendShapes([ { swatch: "line", color: "color-mark-violation",
            text: config["legend-upward"] } ], left - depth * (GROUP_W + GROUP_GAP), below + BAND_MARGIN + 24, config))
    }
    return { ...layout, shapes: [ ...(layout.shapes ?? []), ...shapes ], violates }
}
