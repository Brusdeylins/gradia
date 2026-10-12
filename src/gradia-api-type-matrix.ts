/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Graph }                    from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, Shape, textShape, textWidth }
    from "./gradia-api-render-base.js"
import { LevelContext }             from "./gradia-api-render-container.js"
import { isPrimary, urlOf, orderOf, parentOf, containerTypeOf }
    from "./gradia-api-render-node.js"

/*  the geometry of the row headers  */
const HEAD_PAD = 12   /*  horizontal padding inside a row header  */
const HEAD_GAP = 8    /*  gap between the headers and the cells    */

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

/*  lay out a graph model as a dependency structure matrix (DSM): the
    nodes (in declaration order, or in the order of their "order"
    attributes, the ones without one trailing, while the members of a
    cycle move up to its first member, so every cycle forms a block on
    the diagonal) are both the rows and the columns, a row header
    carrying the node name and its number, a column header its number
    only, and the cell of row X and column Y carrying the number of
    edges from X to Y (their summed numeric arities), while the diagonal
    is shaded and every cycle is outlined as a dashed block with the
    numbers of its edges in the violation color, as a cyclic dependency
    defeats any layering  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph carries no containers, as the rows are flat  */
    const all = Array.from(graph.nodes.values())
    if ((level.fixedSize?.size ?? 0) > 0
        || all.some((node) => parentOf(node) !== undefined || containerTypeOf(node) !== undefined))
        throw new Error("diagram type \"matrix\" does not support containers")
    const sorted = all.toSorted((a, b) => (orderOf(a) ?? Infinity) - (orderOf(b) ?? Infinity) || 0)
    const cycles = cyclesOf(sorted.map((node) => node.id), graph.edges)
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
    const index  = new Map(nodes.map((node, i) => [ node.id, i ]))

    /*  count the edges of every cell (summing the numeric arities, as a
        derived edge may stand for several references)  */
    const counts  = new Map<string, number>()
    const numeric = new Map<string, boolean>()
    for (const edge of graph.edges) {
        const key   = `${index.get(edge.source)!}:${index.get(edge.target)!}`
        const arity = edge.arity !== undefined && /^\d+$/.test(edge.arity) ? Number(edge.arity) : undefined
        counts.set(key, (counts.get(key) ?? 0) + (arity ?? 1))
        numeric.set(key, (numeric.get(key) ?? true) && arity !== undefined)
    }

    /*  resolve the configurable rendering geometry  */
    const margin = config["size-canvas-margin"]
    const cell   = Math.max(config["matrix-cell-size"], 1)
    const fsName = config["size-font-prop"]
    const fsNum  = config["size-font-type"]
    const n      = nodes.length
    const numW   = textWidth(String(n), fsNum) + HEAD_PAD
    const nameW  = nodes.reduce((w, node) => Math.max(w, textWidth(node.name, fsName)), 0)
    const headW  = Math.ceil(nameW + numW + HEAD_PAD * 2)
    const x0     = margin + headW + HEAD_GAP
    const y0     = margin + fsNum + HEAD_GAP
    const base   = (y: number, size: number) => y + cell / 2 + size * 0.36

    /*  generate the shapes: the column numbers, the row headers (in the
        colors of their node boxes), and the cells  */
    const shapes: Shape[] = []
    nodes.forEach((node, i) => {
        shapes.push(textShape(x0 + i * cell + cell / 2, margin + fsNum, String(i + 1),
            "color-container-name", "size-font-type", config, "middle"))
        const style = isPrimary(node) ? "primary" : "regular"
        const y     = y0 + i * cell
        shapes.push({ kind: "rect", x: margin, y, w: headW, h: cell, rx: 6,
            fill: `color-node-${style}-box`, stroke: `color-node-${style}-border`, width: 2 })
        shapes.push(textShape(margin + HEAD_PAD, base(y, fsName), node.name,
            `color-node-${style}-name`, "size-font-prop", config, "start", true, urlOf(node)))
        shapes.push(textShape(margin + headW - HEAD_PAD, base(y, fsNum), String(i + 1),
            `color-node-${style}-name`, "size-font-type", config, "end"))
    })
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            const [ x, y ] = [ x0 + c * cell, y0 + r * cell ]
            const count    = counts.get(`${r}:${c}`)
            const cr       = cycles.get(nodes[r].id)
            const feedback = count !== undefined && cr !== undefined && cr === cycles.get(nodes[c].id)
            shapes.push({ kind: "rect", x, y, w: cell, h: cell,
                fill:   r === c ? "color-node-ghost-box" : count !== undefined ? "color-node-regular-box" : "color-group-box",
                stroke: "color-group-border", width: 1 })
            if (count !== undefined)
                shapes.push(textShape(x + cell / 2, base(y, fsNum),
                    numeric.get(`${r}:${c}`) === true || count > 1 ? String(count) : "1",
                    feedback ? "color-edge-violation" : "color-node-regular-name", "size-font-type",
                    config, "middle", true))
        }
    }

    /*  outline every cycle as a dashed block on the diagonal (its members
        being consecutive rows and columns)  */
    const blocks = new Map<number, number[]>()
    nodes.forEach((node, i) => {
        const k = cycles.get(node.id)
        if (k !== undefined)
            blocks.set(k, [ ...(blocks.get(k) ?? []), i ])
    })
    for (const rows of blocks.values()) {
        const [ x, y ] = [ x0 + rows[0] * cell, y0 + rows[0] * cell ]
        const size     = rows.length * cell
        shapes.push({ kind: "path", x, y, d: `h ${size} v ${size} h ${-size} z`,
            box: [ x, y, x + size, y + size ], stroke: "color-edge-violation", width: 3, dash: "10 6" })
    }

    /*  hand over the shapes for SVG rendering (no node boxes and edges)  */
    return { nodes: [], edges: [], cx: () => 0, cy: () => 0,
        boxW: new Map(), boxH: new Map(), contentH: new Map(), polys: [], shapes }
}
