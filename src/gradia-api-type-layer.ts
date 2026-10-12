/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge, Graph }        from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, Shape, textShape, textWidth }
    from "./gradia-api-render-base.js"
import { LevelContext, boundsOf }   from "./gradia-api-render-container.js"
import { parentOf, containerTypeOf }
    from "./gradia-api-render-node.js"
import { render as renderGraph }    from "./gradia-api-type-graph.js"

/*  the gap between two neighboring layer bands  */
const BAND_GAP = 8

/*  the special "layer" annotation (the name of the layer of a node)  */
const layerOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "layer")?.val

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

    /*  determine the layers in the order of their first appearance and
        lay out every layer as one explicitly ordered row of a "graph"  */
    const layers = Array.from(new Set(nodes.flatMap((node) => layerOf(node) ?? [])))
    const index  = new Map(layers.map((name, i) => [ name, i ]))
    const indexOf = (id: string): number | undefined => {
        const name = layerOf(graph.nodes.get(id)!)
        return name !== undefined ? index.get(name) : undefined
    }
    const ordered: Graph = {
        nodes: new Map(nodes.map((node) => [ node.id, {
            ...node,
            attrs: [ ...node.attrs.filter((attr) => attr.key !== "layer" && attr.key !== "order"),
                ...(layerOf(node) !== undefined ? [ { key: "order", val: String(index.get(layerOf(node)!)) } ] : []) ]
        } ])),
        edges: graph.edges
    }
    const layout = await renderGraph(ordered, config, level)

    /*  determine the vertical extent of every layer from its node boxes
        and split the gutters between neighboring layers in the middle  */
    const pad    = config["group-box-padding"]
    const fsText = config["size-font-prop"]
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

    /*  draw every layer as a band spanning the whole diagram, with the
        layer name left of its nodes, below the edges and the nodes  */
    const bounds = boundsOf(layout)
    const labelW = layers.reduce((w, name) => Math.max(w, textWidth(name, fsText)), 0)
    const left   = bounds.minX - pad - labelW - pad
    const right  = bounds.maxX + pad
    const shapes: Shape[] = []
    layers.forEach((name, i) => {
        if (!Number.isFinite(top[i]))
            return
        const y1 = i === 0                 ? top[i] - pad    : (bottom[i - 1] + top[i]) / 2 + BAND_GAP / 2
        const y2 = i === layers.length - 1 ? bottom[i] + pad : (bottom[i] + top[i + 1]) / 2 - BAND_GAP / 2
        shapes.push({ kind: "rect", x: left, y: y1, w: right - left, h: y2 - y1, rx: 12,
            fill: "color-group-box", stroke: "color-group-border", width: 3 })
        shapes.push(textShape(left + pad, (y1 + y2) / 2 + fsText * 0.36, name,
            "color-group-name", "size-font-prop", config, "start", true))
    })

    /*  an edge pointing from a lower layer to a higher one violates the
        layering (an edge within a layer or towards a lower one is fine)  */
    const violates = (edge: Edge): boolean => {
        const [ s, t ] = [ indexOf(edge.source), indexOf(edge.target) ]
        return s !== undefined && t !== undefined && s > t
    }
    return { ...layout, shapes: [ ...(layout.shapes ?? []), ...shapes ], violates }
}
