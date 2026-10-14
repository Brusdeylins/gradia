/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Graph }                    from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, Poly, textWidth, onRaster, arrowRoom }
    from "./gradia-api-render-base.js"
import { Shape, pathShape }         from "./gradia-api-render-shape.js"
import { LevelContext, rejectContainers }
    from "./gradia-api-render-container.js"
import { measureNodes, byOrder }    from "./gradia-api-render-node.js"

/*  the geometry of the lifelines and the messages  */
const COLUMN_GAP = 60   /*  minimum gap between two participant boxes  */
const LOOP_H     = 40   /*  height of the loop of a self message       */
const LOOP_AIR   = 24   /*  extra width of the loop of a self message   */
const TAIL       = 32   /*  length of a lifeline below the last message */

/*  lay out a graph model as a sequence diagram: the nodes (in
    declaration order, or in the order of their "order" attributes) are
    the participants, drawn as regular node boxes side by side on top of
    their dashed lifelines, and the edges are the messages, drawn as
    regular edges between the lifelines in declaration order top-down
    (an edge from a node to itself as a loop on its own lifeline)  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph carries no containers, as the participants are flat  */
    const all = Array.from(graph.nodes.values())
    rejectContainers("sequence", all, level)
    const nodes = byOrder(all)

    /*  measure the participant boxes, unified onto the raster-rounded
        size of the largest one, and space the lifelines evenly, wide
        enough for the widest box and for the widest message name  */
    const { boxW, boxH, contentH } = measureNodes(nodes, config, () => config["size-node-height-scale"] / 2)
    const margin = config["size-canvas-margin"]
    const widest = onRaster(nodes.reduce((w, node) => Math.max(w, boxW.get(node.id)!), 0))
    const label  = graph.edges.reduce((w, edge) =>
        Math.max(w, textWidth(edge.name ?? "", config["size-font-edge"])), 0)
    const step   = Math.max(widest + COLUMN_GAP, label + COLUMN_GAP * 1.5)
    const headH  = onRaster(nodes.reduce((h, node) => Math.max(h, boxH.get(node.id)!), 0))
    for (const node of nodes) {
        boxW.set(node.id, widest)
        boxH.set(node.id, headH)
    }
    const xOf = new Map(nodes.map((node, i) => [ node.id, margin + widest / 2 + i * step ]))
    const cy  = margin + headH / 2

    /*  place the messages top-down, one per gap, and route each as a
        straight line between the lifelines (a self message as a loop,
        wide enough for the room of its arrow head, like every other
        edge, plus some air)  */
    const loopW = arrowRoom(config) + LOOP_AIR
    const gap   = config["sequence-message-gap"]
    const polys = new Array<Poly>()
    let y = margin + headH + gap
    for (const edge of graph.edges) {
        const [ sx, tx ] = [ xOf.get(edge.source)!, xOf.get(edge.target)! ]
        if (sx === tx) {
            polys.push([ [ sx, y ], [ sx + loopW, y ], [ sx + loopW, y + LOOP_H ], [ sx, y + LOOP_H ] ])
            y += LOOP_H
        }
        else
            polys.push([ [ sx, y ], [ tx, y ] ])
        y += gap
    }

    /*  draw the lifelines below the participant boxes  */
    const top    = cy + headH / 2
    const end    = y - gap + TAIL
    const shapes: Shape[] = nodes.map((node) =>
        pathShape(xOf.get(node.id)!, top, `v ${end - top}`, [ -1, 0, 1, end - top ], "color-group-border", 2, "8 6"))

    /*  hand over the participants, the messages (with their names
        centered on them), and the lifelines  */
    return { nodes, edges: graph.edges, cx: (id) => xOf.get(id)!, cy: () => cy,
        boxW, boxH, contentH, polys, shapes, centered: true }
}
