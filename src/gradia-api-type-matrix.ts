/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Graph }              from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, Shape, textShape, textWidth }
    from "./gradia-api-render-base.js"
import { LevelContext }             from "./gradia-api-render-container.js"
import { isPrimary, urlOf, orderOf, parentOf, containerTypeOf }
    from "./gradia-api-render-node.js"

/*  the geometry of the row headers  */
const HEAD_PAD = 12   /*  horizontal padding inside a row header  */
const HEAD_GAP = 8    /*  gap between the headers and the cells    */
const BOLD     = 1.1  /*  widening of the bold header labels      */

/*  determine the cycles of a graph: its strongly connected components
    of more than one node (Tarjan), plus the nodes carrying a self-loop,
    each mapped onto the number of its component  */
const cyclesOf = (ids: string[], edges: { source: string, target: string }[]): Map<string, number> => {
    const succ = new Map<string, string[]>(ids.map((id) => [ id, [] ]))
    for (const edge of edges)
        succ.get(edge.source)!.push(edge.target)
    const idx   = new Map<string, number>()
    const low   = new Map<string, number>()
    const stack = new Array<string>()
    const onStk = new Set<string>()
    const comps = new Array<string[]>()
    let counter = 0
    const visit = (v: string) => {
        idx.set(v, counter)
        low.set(v, counter++)
        stack.push(v)
        onStk.add(v)
        for (const w of succ.get(v)!) {
            if (!idx.has(w)) {
                visit(w)
                low.set(v, Math.min(low.get(v)!, low.get(w)!))
            }
            else if (onStk.has(w))
                low.set(v, Math.min(low.get(v)!, idx.get(w)!))
        }
        if (low.get(v) === idx.get(v)) {
            const comp = new Array<string>()
            let w: string
            do {
                w = stack.pop()!
                onStk.delete(w)
                comp.push(w)
            } while (w !== v)
            comps.push(comp)
        }
    }
    for (const id of ids)
        if (!idx.has(id))
            visit(id)
    const cycles = new Map<string, number>()
    comps.forEach((comp, k) => {
        if (comp.length > 1 || succ.get(comp[0])!.includes(comp[0]))
            for (const id of comp)
                cycles.set(id, k)
    })
    return cycles
}

/*  the special "axis" annotation (a node of the value "column" being
    a column of a traceability matrix)  */
const isColumn = (node: Node): boolean =>
    node.attrs.findLast((attr) => attr.key === "axis")?.val === "column"

/*  lay out a graph model as a matrix, either as a dependency structure
    matrix (DSM), if no node carries the attribute "axis: column", or
    else as a traceability matrix. In a DSM the nodes (in declaration
    order, or in the order of their "order" attributes, the ones without
    one trailing, while the members of a cycle move up to its first
    member, so every cycle forms a block on the diagonal) are both the
    rows and the columns, and the cell of row X and column Y carries the
    number of edges from X to Y (their summed numeric arities), i.e. a
    matrix reads from a row to its columns, while the diagonal is shaded
    and every cycle is outlined as a dashed block with the numbers of its
    edges in the violation color, as a cyclic dependency defeats any
    layering. In a traceability matrix the "axis: column" nodes are the
    columns and all other nodes the rows, a cell counts the edges between
    its row and its column in either direction (as a trace is recorded on
    either side), and a row or column without any entry is marked as a
    gap in the violation color. The row and column headers carry the
    node labels in boxes of the node box colors, lying and upright  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph carries no containers, as the rows are flat  */
    const all = Array.from(graph.nodes.values())
    if ((level.fixedSize?.size ?? 0) > 0
        || all.some((node) => parentOf(node) !== undefined || containerTypeOf(node) !== undefined))
        throw new Error("diagram type \"matrix\" does not support containers")
    const sorted = all.toSorted((a, b) => (orderOf(a) ?? Infinity) - (orderOf(b) ?? Infinity) || 0)
    const traced = sorted.some((node) => isColumn(node))

    /*  determine the rows and columns: in a DSM both are the nodes, with
        the members of every cycle consecutive, in a traceability matrix
        the two sets of nodes  */
    const cycles = traced ? new Map<string, number>() : cyclesOf(sorted.map((node) => node.id), graph.edges)
    const first  = new Map<number, number>()
    sorted.forEach((node, i) => {
        const k = cycles.get(node.id)
        if (k !== undefined && !first.has(k))
            first.set(k, i)
    })
    const rank   = (id: string, i: number) => {
        const k = cycles.get(id)
        return k !== undefined ? first.get(k)! : i
    }
    const nodes  = sorted.map((node, i) => ({ node, r: rank(node.id, i), i }))
        .sort((a, b) => a.r - b.r || a.i - b.i).map(({ node }) => node)
    const rows   = traced ? nodes.filter((node) => !isColumn(node)) : nodes
    const cols   = traced ? nodes.filter((node) =>  isColumn(node)) : nodes
    const rowOf  = new Map(rows.map((node, i) => [ node.id, i ]))
    const colOf  = new Map(cols.map((node, i) => [ node.id, i ]))

    /*  count the edges of every cell (summing the numeric arities, as a
        derived edge may stand for several references), in a traceability
        matrix regardless of their direction  */
    const counts = new Map<string, number>()
    for (const edge of graph.edges) {
        let [ r, c ] = [ rowOf.get(edge.source), colOf.get(edge.target) ]
        if (traced && (r === undefined || c === undefined))
            [ r, c ] = [ rowOf.get(edge.target), colOf.get(edge.source) ]
        if (r === undefined || c === undefined)
            continue
        const arity = edge.arity !== undefined && /^\d+$/.test(edge.arity) ? Number(edge.arity) : 1
        counts.set(`${r}:${c}`, (counts.get(`${r}:${c}`) ?? 0) + arity)
    }
    const usedRows = new Set(Array.from(counts.keys(), (key) => Number(key.split(":")[0])))
    const usedCols = new Set(Array.from(counts.keys(), (key) => Number(key.split(":")[1])))

    /*  resolve the configurable rendering geometry  */
    const margin = config["size-canvas-margin"]
    const cell   = Math.max(config["matrix-cell-size"], 1)
    const fsName = config["size-font-prop"]
    const fsNum  = config["size-font-type"]
    const headOf = (list: Node[]) =>
        Math.ceil(list.reduce((w, node) => Math.max(w, textWidth(node.name, fsName) * BOLD), 0) + HEAD_PAD * 2)
    const rowW   = headOf(rows)
    const colH   = headOf(cols)
    const x0     = margin + rowW + HEAD_GAP
    const y0     = margin + colH + HEAD_GAP
    const base   = (y: number, size: number) => y + cell / 2 + size * 0.36

    /*  generate the shapes: the column headers (upright boxes, the node
        labels running upwards) and the row headers (the very same boxes
        lying), both in the colors of the node boxes (a gap of a
        traceability matrix outlined dashed in the violation color), and
        the cells  */
    const shapes: Shape[] = []
    const gaps:   Shape[] = []
    const header = (node: Node, x: number, y: number, w: number, h: number, gap: boolean) => {
        const style = isPrimary(node) ? "primary" : "regular"
        shapes.push({ kind: "rect", x, y, w, h, rx: 6, fill: `color-node-${style}-box`,
            stroke: `color-node-${style}-border`, width: 2 })
        if (gap)
            gaps.push({ kind: "path", x: x + 6, y,
                d: `h ${w - 12} a 6 6 0 0 1 6 6 v ${h - 12} a 6 6 0 0 1 -6 6 ` +
                    `h ${12 - w} a 6 6 0 0 1 -6 -6 v ${12 - h} a 6 6 0 0 1 6 -6 z`,
                box: [ x, y, x + w, y + h ], stroke: "color-edge-violation", width: 2, dash: "6 4" })
        shapes.push(w < h ?
            textShape(x + cell / 2 + fsName * 0.36, y + h - HEAD_PAD, node.name,
                `color-node-${style}-name`, "size-font-prop", config, "start", true, urlOf(node), true) :
            textShape(x + HEAD_PAD, base(y, fsName), node.name,
                `color-node-${style}-name`, "size-font-prop", config, "start", true, urlOf(node)))
    }
    cols.forEach((node, c) => header(node, x0 + c * cell, margin, cell, colH, traced && !usedCols.has(c)))
    rows.forEach((node, r) => header(node, margin, y0 + r * cell, rowW, cell, traced && !usedRows.has(r)))

    /*  the gap outlines lie above all headers, as the neighboring header
        boxes would otherwise cover parts of them  */
    shapes.push(...gaps)
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < cols.length; c++) {
            const [ x, y ] = [ x0 + c * cell, y0 + r * cell ]
            const count    = counts.get(`${r}:${c}`)
            const diagonal = !traced && r === c
            const k        = cycles.get(rows[r].id)
            const feedback = count !== undefined && k !== undefined && k === cycles.get(cols[c].id)
            shapes.push({ kind: "rect", x, y, w: cell, h: cell,
                fill:   diagonal ? "color-node-ghost-box" : count !== undefined ? "color-node-regular-box" : "color-group-box",
                stroke: "color-group-border", width: 1 })
            if (count !== undefined)
                shapes.push(textShape(x + cell / 2, base(y, fsNum), String(count),
                    feedback ? "color-edge-violation" : "color-node-regular-name", "size-font-type",
                    config, "middle", true))
        }
    }

    /*  outline every cycle of a DSM as a dashed block on the diagonal
        (its members being consecutive rows and columns)  */
    const blocks = new Map<number, number[]>()
    nodes.forEach((node, i) => {
        const k = cycles.get(node.id)
        if (k !== undefined)
            blocks.set(k, [ ...(blocks.get(k) ?? []), i ])
    })
    for (const members of blocks.values()) {
        const [ x, y ] = [ x0 + members[0] * cell, y0 + members[0] * cell ]
        const size     = members.length * cell
        shapes.push({ kind: "path", x, y, d: `h ${size} v ${size} h ${-size} z`,
            box: [ x, y, x + size, y + size ], stroke: "color-edge-violation", width: 3, dash: "10 6" })
    }

    /*  hand over the shapes for SVG rendering (no node boxes and edges)  */
    return { nodes: [], edges: [], cx: () => 0, cy: () => 0,
        boxW: new Map(), boxH: new Map(), contentH: new Map(), polys: [], shapes }
}
