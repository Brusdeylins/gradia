/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Graph }           from "./gradia-api-model.js"
import { Config }                from "./gradia-api-config.js"
import { measureNodes, orderOf } from "./gradia-api-render-node.js"
import { Layout, onRaster }      from "./gradia-api-render-base.js"
import { LevelContext }          from "./gradia-api-render-container.js"

/*  lay out an edge-less graph model as a compact grid of tiles (for a
    containment level: with the container placeholders at their fixed
    sizes, which take part in the tile width unification only), the tiles in
    declaration order, or in the order of their "order" attributes
    (the tiles without one trailing)  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  determine the tiles in their rendering order  */
    const nodes = Array.from(graph.nodes.values())
        .sort((a, b) => (orderOf(a) ?? Infinity) - (orderOf(b) ?? Infinity) || 0)

    /*  resolve the configurable rendering geometry  */
    const margin  = config["size-canvas-margin"]
    const gapH    = config["grid-gap-horizontal"]
    const gapV    = config["grid-gap-vertical"]
    const maxCols = Math.max(Math.floor(config["grid-columns-max"]), 1)
    const minCols = Math.max(Math.floor(config["grid-columns-min"]), 1)

    /*  ensure the graph is completely edge-less  */
    if (graph.edges.length > 0) {
        const edge = graph.edges[0]
        throw new Error("diagram type \"grid\" does not support edges " +
            `(found ${graph.edges.length}, first is "${edge.source}" --> "${edge.target}")`)
    }

    /*  determine node box sizes, rounded up to the raster step, and, if
        configured, unify their widths into a single tile width (the
        container placeholders included, so the container boxes line up)
        and their heights into a single tile height (the container
        placeholders excluded, as the height of a container box is the
        one of its content)  */
    const { boxW, boxH, contentH } = measureNodes(nodes, config,
        () => config["size-node-height-scale"] / 2, level.fixedSize)
    const isFixed = (node: Node): boolean => level.fixedSize?.has(node.id) ?? false
    for (const node of nodes) {
        if (!isFixed(node)) {
            boxW.set(node.id, onRaster(boxW.get(node.id)!))
            boxH.set(node.id, onRaster(boxH.get(node.id)!))
        }
    }
    const tileH = nodes.reduce((a, node) => isFixed(node) ? a : Math.max(a, boxH.get(node.id)!), 0)
    const tileW = nodes.reduce((a, node) => Math.max(a, boxW.get(node.id)!), 0)
    for (const node of nodes) {
        if (config["grid-node-height-equal"] && !isFixed(node))
            boxH.set(node.id, tileH)
        if (config["grid-node-width-equal"])
            boxW.set(node.id, tileW)
    }

    /*  place the nodes in their rendering order onto a roughly square,
        row-major grid (raised to the configured minimum of columns, so
        few nodes still share a row, and capped at the configured maximum
        of columns and the node count, so larger graphs grow only in
        height), with each column as wide as its widest tile and each
        row as tall as its tallest tile, and each tile left-aligned
        within its column and top-aligned within its row  */
    const cols      = Math.max(Math.min(Math.max(Math.ceil(Math.sqrt(nodes.length)), minCols),
        maxCols, nodes.length), 1)
    const rows      = Math.ceil(nodes.length / cols)
    const colWidth  = Array.from({ length: cols }, () => 0)
    const rowHeight = Array.from({ length: rows }, () => 0)
    nodes.forEach((node, i) => {
        const [ c, r ] = [ i % cols, Math.floor(i / cols) ]
        colWidth[c]  = Math.max(colWidth[c],  boxW.get(node.id)!)
        rowHeight[r] = Math.max(rowHeight[r], boxH.get(node.id)!)
    })
    const colLX: number[] = []
    let x = margin
    for (let c = 0; c < cols; c++) {
        colLX.push(x)
        x += colWidth[c] + gapH
    }
    const rowTY: number[] = []
    let y = margin
    for (let r = 0; r < rows; r++) {
        rowTY.push(y)
        y += rowHeight[r] + gapV
    }
    const nodeCX = new Map<string, number>()
    const nodeCY = new Map<string, number>()
    nodes.forEach((node, i) => {
        nodeCX.set(node.id, colLX[i % cols] + boxW.get(node.id)! / 2)
        nodeCY.set(node.id, rowTY[Math.floor(i / cols)] + boxH.get(node.id)! / 2)
    })
    const cx = (id: string) => nodeCX.get(id)!
    const cy = (id: string) => nodeCY.get(id)!

    /*  hand over the laid out graph for SVG rendering  */
    return { nodes, edges: [], cx, cy, boxW, boxH, contentH, polys: [] }
}

