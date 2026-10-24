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

/*  the gap between two neighboring layer bands, the margin of a band
    around its node boxes, and the geometry of the groups and numbers  */
const BAND_GAP    = 8
const BAND_MARGIN = 20
const GROUP_W     = 40   /*  width of a group column              */
const GROUP_GAP   = 8    /*  gap between the group columns        */
const NUMBER_R    = 13   /*  radius of the circle of a number     */

/*  the special "layer" annotation (the name of the layer of a node)  */
const layerOf = (node: Node): string | undefined =>
    node.attrs.findLast((attr) => attr.key === "layer")?.val

/*  the special "layer-group" annotation (the "/"-separated path of the
    nested groups the layer of a node belongs to, outermost first)  */
const groupsOf = (node: Node): string[] =>
    (node.attrs.findLast((attr) => attr.key === "layer-group")?.val ?? "")
        .split("/").map((name) => name.trim()).filter((name) => name !== "")

/*  lay out a graph model as a layered architecture: the layers, in the
    order of their first appearance, become bands stacked top-down, and
    an edge from a lower layer to a higher one, i.e. pointing upwards
    against the layering, is marked as a violation  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph carries no containers, as the bands are the
        only nesting of a layered diagram  */
    const nodes = Array.from(graph.nodes.values())
    rejectContainers("layer", nodes, level)

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
    type Tree = Map<string, Tree>
    const tree: Tree = new Map()
    for (const [ layer, path ] of pathOf) {
        let t = tree
        for (const name of path) {
            if (!t.has(`g:${name}`))
                t.set(`g:${name}`, new Map())
            t = t.get(`g:${name}`)!
        }
        t.set(`l:${layer}`, new Map())
    }
    const flat = (t: Tree): string[] =>
        Array.from(t).flatMap(([ key, sub ]) => key.startsWith("l:") ? [ key.slice(2) ] : flat(sub))
    const layers = flat(tree)
    const index   = new Map(layers.map((name, i) => [ name, i ]))
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
        the layer name (optionally preceded by its number) left of its
        nodes in the bold font of the group tags, below the edges and the
        nodes  */
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
        const [ y1, y2 ] = [ y1Of(i), y2Of(i) ]
        const mid = (y1 + y2) / 2
        shapes.push(rectShape(left, y1, right - left, y2 - y1, "color-container-border", 2,
            undefined, "color-container-box", 12))
        if (numbered) {
            const fs = config["size-font-type"]
            shapes.push(rectShape(left + pad, mid - NUMBER_R, NUMBER_R * 2, NUMBER_R * 2, "color-container-name", 2,
                undefined, "color-container-box", NUMBER_R))
            shapes.push(textShape(left + pad + NUMBER_R, mid, String(i + 1), "middle", textWidth(String(i + 1), fs, true),
                "color-container-name", "size-font-type", fs, { bold: true, halo: false }))
        }
        shapes.push(textShape(left + pad + numberW, mid, name, "start", textWidth(name, FS_GROUP, true),
            "color-container-name", FS_GROUP, FS_GROUP, { bold: true, halo: false }))
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
            shapes.push(rectShape(x, y1, GROUP_W, y2 - y1, "color-container-border", 2,
                undefined, "color-container-box", 12))
            shapes.push(textShape(x + GROUP_W / 2, (y1 + y2) / 2, path[k], "middle", textWidth(path[k], FS_GROUP, true),
                "color-container-name", FS_GROUP, FS_GROUP, { bold: true, halo: false, upright: true }))
            start = end + 1
        }
    }

    /*  hand over the laid out graph with the bands and the violations  */
    const marked = layout.edges.map((edge) => violates(edge))
    return { ...layout, shapes, marked }
}
