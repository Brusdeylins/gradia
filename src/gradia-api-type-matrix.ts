/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Graph }              from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, textWidth }        from "./gradia-api-render-base.js"
import { Shape, textShape, rectShape } from "./gradia-api-render-shape.js"
import { LevelContext, rejectContainers }
    from "./gradia-api-render-container.js"
import { defaultStyleOf, urlOf, orderOf, typeOf }
    from "./gradia-api-render-node.js"

/*  the geometry of the cells and the row headers  */
const CELL     = 44   /*  width and height of a cell               */
const HEAD_PAD = 12   /*  horizontal padding inside a row header   */
const HEAD_GAP = 8    /*  gap between the headers and the cells    */

/*  determine the cycles of a graph: every node reaching itself through
    its edges, mapped onto the index of the first node of its strongly
    connected component (the nodes reaching each other)  */
const cyclesOf = (ids: string[], edges: { source: string, target: string }[]): Map<string, number> => {
    const succ = new Map<string, string[]>(ids.map((id) => [ id, [] ]))
    for (const edge of edges)
        succ.get(edge.source)!.push(edge.target)
    const reach = new Map(ids.map((id) => {
        const seen = new Set<string>()
        const todo = [ ...succ.get(id)! ]
        for (let v = todo.pop(); v !== undefined; v = todo.pop()) {
            if (!seen.has(v)) {
                seen.add(v)
                todo.push(...succ.get(v)!)
            }
        }
        return [ id, seen ]
    }))
    const cycles = new Map<string, number>()
    ids.forEach((id, k) => {
        if (reach.get(id)!.has(id) && !cycles.has(id))
            for (const other of ids)
                if (reach.get(id)!.has(other) && reach.get(other)!.has(id))
                    cycles.set(other, k)
    })
    return cycles
}

/*  lay out a graph model as a dependency structure matrix (DSM): the
    nodes are both its rows and its columns (the members of a cycle
    moved together, so every cycle forms a block on the diagonal), and
    the cell of row X and column Y counts the edges from X to Y  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph carries no containers, as the rows are flat  */
    const sorted = Array.from(graph.nodes.values())
        .sort((a, b) => (orderOf(a) ?? Infinity) - (orderOf(b) ?? Infinity) || 0)
    rejectContainers("matrix", sorted, level)

    /*  determine the rows and columns: both are the nodes, with the
        members of every cycle consecutive  */
    const cycles = cyclesOf(sorted.map((node) => node.id), graph.edges)
    const nodes  = sorted.map((node, i) => ({ node, r: cycles.get(node.id) ?? i, i }))
        .sort((a, b) => a.r - b.r || a.i - b.i).map(({ node }) => node)
    const rows   = nodes
    const cols   = nodes
    const rowOf  = new Map(rows.map((node, i) => [ node.id, i ]))
    const colOf  = new Map(cols.map((node, i) => [ node.id, i ]))

    /*  count the edges of every cell (summing the numeric arities, as a
        derived edge may stand for several references)  */
    const counts = new Map<number, number>()
    const cellOf = (r: number, c: number) => r * cols.length + c
    for (const edge of graph.edges) {
        const [ r, c ] = [ rowOf.get(edge.source)!, colOf.get(edge.target)! ]
        const arity = edge.arity !== undefined && /^\d+$/.test(edge.arity) ? Number(edge.arity) : 1
        counts.set(cellOf(r, c), (counts.get(cellOf(r, c)) ?? 0) + arity)
    }

    /*  resolve the configurable rendering geometry  */
    const margin = config["size-canvas-margin"]
    const fsName = config["size-font-prop"]
    const fsNum  = config["size-font-type"]
    const headOf = (list: Node[]) =>
        Math.ceil(list.reduce((w, node) => Math.max(w, textWidth(node.name, fsName, true)), 0) + HEAD_PAD * 2)

    /*  the titles of the rows and the columns: the type shared by all of
        their nodes, if any  */
    const titleOf = (list: Node[]): string | undefined => {
        const [ type, ...more ] = new Set(list.map((node) => typeOf(node)))
        return more.length === 0 && type !== undefined && type !== "" ? type : undefined
    }
    const rowTitle = titleOf(rows)
    const colTitle = titleOf(cols)
    const titleW   = Math.max(textWidth(rowTitle ?? "", fsNum, true), textWidth(colTitle ?? "", fsNum, true))
    const rowW   = Math.max(headOf(rows), Math.ceil(titleW + HEAD_PAD * 2))
    const colH   = Math.max(headOf(cols), Math.ceil(fsNum * 4))
    const x0     = margin + rowW + HEAD_GAP
    const y0     = margin + colH + HEAD_GAP

    /*  generate the shapes: the column headers (upright boxes, the node
        labels running upwards) and the row headers (the very same boxes
        lying), both in the colors of the node boxes, and the cells  */
    const shapes: Shape[] = []
    const header = (node: Node, x: number, y: number, w: number, h: number, upright: boolean) => {
        const { fill, stroke, text } = defaultStyleOf(node)
        shapes.push(rectShape(x, y, w, h, stroke, 2, undefined, fill, 6))
        const [ tx, ty ] = upright ? [ x + CELL / 2, y + h - HEAD_PAD ] : [ x + HEAD_PAD, y + CELL / 2 ]
        shapes.push(textShape(tx, ty, node.name, "start", textWidth(node.name, fsName, true), text, "size-font-prop",
            fsName, { bold: true, url: urlOf(node), halo: false, upright }))
    }
    cols.forEach((node, c) => header(node, x0 + c * CELL, margin, CELL, colH, true))
    rows.forEach((node, r) => header(node, margin, y0 + r * CELL, rowW, CELL, false))

    /*  the titles of the rows and the columns in the corner  */
    if (rowTitle !== undefined)
        shapes.push(textShape(margin + HEAD_PAD, margin + colH - HEAD_PAD - fsNum * 0.35, rowTitle, "start",
            textWidth(rowTitle, fsNum, true), "color-container-name", "size-font-type", fsNum, { bold: true, halo: false }))
    if (colTitle !== undefined)
        shapes.push(textShape(margin + rowW - HEAD_PAD, margin + HEAD_PAD + fsNum * 0.65, colTitle, "end",
            textWidth(colTitle, fsNum, true), "color-container-name", "size-font-type", fsNum, { bold: true, halo: false }))

    /*  the cells: the diagonal shaded, the cells with an entry in the
        node box color, the numbers of the edges within a cycle in the
        violation color  */
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < cols.length; c++) {
            const [ x, y ] = [ x0 + c * CELL, y0 + r * CELL ]
            const count    = counts.get(cellOf(r, c))
            const k        = cycles.get(rows[r].id)
            const feedback = count !== undefined && k !== undefined && k === cycles.get(cols[c].id)
            shapes.push(rectShape(x, y, CELL, CELL, "color-container-border", 1, undefined,
                r === c ? "color-node-self-box" : count !== undefined ? "color-node-regular-box" : "color-container-box"))
            if (count !== undefined)
                shapes.push(textShape(x + CELL / 2, y + CELL / 2, String(count), "middle",
                    textWidth(String(count), fsNum, true), feedback ? "color-mark-violation" : "color-node-regular-name",
                    "size-font-type", fsNum, { bold: true, halo: false }))
        }
    }

    /*  outline every cycle as a dashed block on the diagonal (its
        members being consecutive rows and columns)  */
    const blocks = new Map<number, number[]>()
    nodes.forEach((node, i) => {
        const k = cycles.get(node.id)
        if (k !== undefined)
            blocks.set(k, [ ...(blocks.get(k) ?? []), i ])
    })
    for (const members of blocks.values()) {
        const [ x, y ] = [ x0 + members[0] * CELL, y0 + members[0] * CELL ]
        const size     = members.length * CELL
        shapes.push(rectShape(x, y, size, size, "color-mark-violation", 3, "10 6"))
    }

    /*  hand over the shapes for SVG rendering (no node boxes and edges)  */
    return { nodes: [], edges: [], cx: () => 0, cy: () => 0,
        boxW: new Map(), boxH: new Map(), contentH: new Map(), polys: [], shapes }
}
