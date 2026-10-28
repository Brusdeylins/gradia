/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Edge, Graph }        from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, FS_GROUP, textWidth }
    from "./gradia-api-render-base.js"
import { Shape, textShape, rectShape } from "./gradia-api-render-shape.js"
import { LevelContext, rejectContainers, boundsOf }
    from "./gradia-api-render-container.js"
import { render as renderGraph }    from "./gradia-api-type-graph.js"

/*  the gap between two neighboring layer bands, and the margin of a
    band around its node boxes  */
const BAND_GAP    = 8
const BAND_MARGIN = 20

/*  the special "layer" annotation (the name of the layer of a node)  */
const layerOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "layer")?.val

/*  lay out a graph model as a layered architecture: the layers, in the
    order of their first appearance, become bands stacked top-down, and
    an edge from a lower layer to a higher one, i.e. pointing upwards
    against the layering, is marked as a violation  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph carries no containers, as the bands are the
        only nesting of a layered diagram  */
    const nodes = Array.from(graph.nodes.values())
    rejectContainers("layer", nodes, level)

    /*  determine the layers in the order of their first appearance and
        lay out every layer as one explicitly ordered row of a "graph"  */
    const layers  = Array.from(new Set(nodes.map(layerOf).filter((name) => name !== undefined)))
    const index   = new Map(layers.map((name, i) => [ name, i ]))
    const indexOf = (id: string): number | undefined => {
        const node = graph.nodes.get(id)
        const name = node !== undefined ? layerOf(node) : undefined
        return name !== undefined ? index.get(name) : undefined
    }
    const ordered: Graph = {
        nodes: new Map(nodes.map((node) => [ node.id, {
            ...node,
            attrs: [ ...node.attrs.filter((attr) => ![ "layer", "order" ].includes(attr.key)),
                ...(layerOf(node) !== undefined ? [ { key: "order", val: String(index.get(layerOf(node)!)) } ] : []) ]
        } ])),
        edges: graph.edges
    }

    /*  an edge pointing from a lower layer to a higher one violates the
        layering (an edge within a layer or towards a lower one is fine)  */
    const violates = (edge: Edge): boolean => {
        const [ s, t ] = [ indexOf(edge.source), indexOf(edge.target) ]
        return s !== undefined && t !== undefined && s > t
    }

    /*  lay out the graph uniformly (see "Uniform"), with the gutters
        holding the margins of the two bands beside them plus their gap  */
    const cfg    = { ...config, "graph-gutter-height-min":
        Math.max(config["graph-gutter-height-min"], BAND_MARGIN * 2 + BAND_GAP) }
    const layout = await renderGraph(ordered, cfg, level, { laneOf: (id) => indexOf(id) ?? -1, markOf: violates })

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
    const bounds = boundsOf(layout)
    const labelW = layers.reduce((w, name) => Math.max(w, textWidth(name, FS_GROUP, true)), 0)
    const left   = bounds.minX - pad - labelW - pad
    const right  = bounds.maxX + pad
    const shapes: Shape[] = []
    layers.forEach((name, i) => {
        const [ y1, y2 ] = [ top[i] - BAND_MARGIN, bottom[i] + BAND_MARGIN ]
        shapes.push(rectShape(left, y1, right - left, y2 - y1, "color-container-border", 2,
            undefined, "color-container-box", 12))
        shapes.push(textShape(left + pad, (y1 + y2) / 2, name, "start", textWidth(name, FS_GROUP, true),
            "color-container-name", FS_GROUP, FS_GROUP, { bold: true, halo: false }))
    })

    /*  hand over the laid out graph with the bands and the violations  */
    const marked = layout.edges.map((edge) => violates(edge))
    return { ...layout, shapes, marked }
}
