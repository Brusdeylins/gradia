/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Node, Graph }                      from "./gradia-api-model.js"
import { Config }                           from "./gradia-api-config.js"
import { Layout, textWidth }                from "./gradia-api-render-base.js"
import { Shape, textShape, pathShape, rectShape } from "./gradia-api-render-shape.js"
import { LevelContext, rejectContainers }   from "./gradia-api-render-container.js"
import { urlOf }                            from "./gradia-api-render-node.js"

/*  the geometry of the cells and the annotations around the cell rows  */
const CELL       = 44   /*  width and height of a cell                      */
const RULER_GAP  = 8    /*  gap between the ruler and the first row         */
const BRACE_GAP  = 6    /*  gap between a row and its braces                */
const BRACE_D    = 8    /*  depth of a brace (half of its total height)     */
const LABEL_GAP  = 6    /*  gap between a brace tip and its label           */
const LABEL_SEP  = 12   /*  minimum horizontal gap between two labels       */
const ROW_GAP    = 24   /*  vertical gap between two rows                   */
const ROW_LABEL  = 16   /*  gap between a row and its offset label          */

/*  the upper bounds of the cells of a layout, as the input is untrusted
    and every cell becomes several SVG elements  */
const ROW_CELLS_MAX = 256    /*  maximum of "layout-row-cells"           */
const CELLS_MAX     = 4096   /*  maximum of the cells of all rows        */

/*  a field of the layout: a node with its cell offset, cell size, and
    optional fixed value  */
interface Field {
    node:   Node
    offset: number
    size:   number
    open:   boolean
    value?: string
}

/*  the part of a field within a single row  */
interface Segment {
    field: Field
    row:   number
    from:  number   /*  first cell within the row      */
    to:    number   /*  cell after the last one         */
}

/*  the label of a field (a variable-sized one marked as continuing)  */
const labelOf = (field: Field): string =>
    field.open ? `${field.node.name} ...` : field.node.name

/*  whether the value of a field carries exactly one character per cell
    (counted in code points, so a surrogate pair stays one character)  */
const perCell = (field: Field): boolean =>
    field.value !== undefined && Array.from(field.value).length === field.size

/*  parse a cell count attribute (a decimal or hexadecimal integer)  */
const cellsOf = (node: Node, key: string, min: number): number | undefined => {
    const val = node.attrs.findLast((attr) => attr.key === key)?.val
    if (val === undefined)
        return undefined
    const num = /^0x[0-9a-f]+$/i.test(val.trim()) ? parseInt(val.trim(), 16) :
        /^\d+$/.test(val.trim()) ? parseInt(val.trim(), 10) : NaN
    if (!Number.isInteger(num) || num < min)
        throw new Error(`invalid "${key}" attribute "${val}" of node "${node.id}" ` +
            `(expected an integer of at least ${min})`)
    return num
}

/*  lay out an edge-less graph model as the cell layout of a binary
    structure: every node is a field of "size" cells at cell "offset"
    (a "size" of "*" running to the end of its row), drawn as a run of
    cells in rows of "layout-row-cells" cells (continuing in the next
    row), labeled below through a brace (or a tick) and optionally
    carrying its fixed "value", while uncovered cells are drawn as gaps  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  ensure the graph is a plain, edge-less set of fields  */
    if (graph.edges.length > 0) {
        const edge = graph.edges[0]
        throw new Error("diagram type \"layout\" does not support edges " +
            `(found ${graph.edges.length}, first is "${edge.source}" --> "${edge.target}")`)
    }
    const nodes = Array.from(graph.nodes.values())
    rejectContainers("layout", nodes, level)

    /*  resolve the configurable rendering geometry  */
    const margin = config["size-canvas-margin"]
    const cols   = Math.max(Math.floor(config["layout-row-cells"]), 1)
    if (cols > ROW_CELLS_MAX)
        throw new Error(`invalid "layout-row-cells" value ${cols} (expected at most ${ROW_CELLS_MAX})`)
    const bits   = Math.max(Math.floor(config["layout-cell-bits"]), 1)
    const fsRule = config["size-font-type"]
    const fsText = config["size-font-prop"]
    const tierH  = Math.round(fsText * 1.3)

    /*  determine the fields in the order of their offsets and reject
        overlapping ones, as a cell can belong to one field only  */
    const fields: Field[] = nodes.map((node) => {
        const offset = cellsOf(node, "offset", 0)
        const open   = node.attrs.findLast((attr) => attr.key === "size")?.val.trim() === "*"
        const size   = open && offset !== undefined ? cols - offset % cols : cellsOf(node, "size", 1)
        if (offset === undefined || size === undefined)
            throw new Error(`node "${node.id}" lacks the "offset" or "size" attribute ` +
                "required by diagram type \"layout\"")
        const value = node.attrs.findLast((attr) => attr.key === "value")?.val
        return { node, offset, size, open, value }
    }).sort((a, b) => a.offset - b.offset)
    for (let i = 1; i < fields.length; i++)
        if (fields[i].offset < fields[i - 1].offset + fields[i - 1].size)
            throw new Error(`field "${fields[i].node.id}" overlaps field "${fields[i - 1].node.id}"`)
    const total = fields.reduce((n, field) => Math.max(n, field.offset + field.size), 0)
    if (total > CELLS_MAX)
        throw new Error(`layout spans ${total} cells (expected at most ${CELLS_MAX})`)
    const rows  = Math.max(Math.ceil(total / cols), 1)

    /*  split the fields into their per-row segments  */
    const segments: Segment[] = []
    for (const field of fields) {
        for (let pos = field.offset; pos < field.offset + field.size;) {
            const row = Math.floor(pos / cols)
            const end = Math.min(field.offset + field.size, (row + 1) * cols)
            segments.push({ field, row, from: pos - row * cols, to: end - row * cols })
            pos = end
        }
    }

    /*  assign the labels of every row to tiers below the row: a label
        takes the first tier where it keeps clear of the labels already
        placed there, so narrow neighboring fields stagger downwards  */
    const xOf     = (c: number) => margin + c * CELL
    const midOf   = (seg: Segment) => (xOf(seg.from) + xOf(seg.to)) / 2
    const tierOf  = new Map<Segment, number>()
    const tiersOf = new Array<number>(rows).fill(0)
    for (let row = 0; row < rows; row++) {
        const ends: number[] = []
        for (const seg of segments.filter((s) => s.row === row).sort((a, b) => midOf(a) - midOf(b))) {
            const w    = textWidth(labelOf(seg.field), fsText)
            const left = midOf(seg) - w / 2
            let tier   = ends.findIndex((end) => left >= end + LABEL_SEP)
            if (tier < 0)
                tier = ends.push(0) - 1
            ends[tier] = left + w
            tierOf.set(seg, tier)
        }
        tiersOf[row] = Math.max(ends.length, 1)
    }

    /*  determine the vertical position of every row: the ruler above the
        first row, and below every row its braces and label tiers  */
    const rowTop: number[] = []
    let y = margin + fsRule + RULER_GAP
    for (let row = 0; row < rows; row++) {
        rowTop.push(y)
        y += CELL + BRACE_GAP + BRACE_D * 2 + LABEL_GAP + tiersOf[row] * tierH + ROW_GAP
    }

    /*  generate the shapes: the ruler, the cells (covered and the gaps
        between the fields, but none behind the last field), the field
        outlines, the values, the braces (a tick for a single cell) with
        their labels, and the offset label of every row  */
    const shapes: Shape[] = []
    for (let c = 0; c < cols; c++)
        shapes.push(textShape(xOf(c) + CELL / 2, margin + fsRule * 0.65, String(c), "middle",
            textWidth(String(c), fsRule), "color-container-name", "size-font-type", fsRule))
    let next = 0
    for (let row = 0; row < rows; row++) {
        for (let c = 0; c < cols && row * cols + c < total; c++) {
            /*  the field covering the cell (cells and fields both ascending, so
                a forward scan past the fields ending before the cell suffices)  */
            const pos = row * cols + c
            while (next < fields.length && fields[next].offset + fields[next].size <= pos)
                next++
            const field = next < fields.length && fields[next].offset <= pos ? fields[next] : undefined

            /*  the cells of a field carrying one value across all of them
                merge into a single box, so no cell border crosses the value  */
            const style  = field === undefined ? "ghost" : "regular"
            const merged = field !== undefined && field.value !== undefined && !perCell(field)
            if (merged && pos !== Math.max(field.offset, row * cols))
                continue
            const w = merged ? (Math.min(field.offset + field.size, (row + 1) * cols) - row * cols - c) * CELL : CELL
            shapes.push(rectShape(xOf(c), rowTop[row], w, CELL, `color-node-${style}-border`, 2,
                field === undefined ? "6 4" : undefined, `color-node-${style}-box`))
        }
        const offset = row * cols * bits
        const label  = offset % 8 === 0 ? `0x${(offset / 8).toString(16).padStart(2, "0")}` : `bit ${offset}`
        shapes.push(textShape(xOf(cols) + ROW_LABEL, rowTop[row] + CELL / 2, label, "start",
            textWidth(label, fsText), "color-container-name", "size-font-prop", fsText))
    }
    for (const seg of segments) {
        const { field, row } = seg
        const top   = rowTop[row]
        const [ xa, xb ] = [ xOf(seg.from), xOf(seg.to) ]

        /*  the outline of the field segment  */
        shapes.push(rectShape(xa, top, xb - xa, CELL, "color-node-regular-border", 4))

        /*  the value, one digit per cell or once in the middle (in the
            smaller font, so it keeps clear of the borders of the cells)  */
        if (field.value !== undefined) {
            const mid = top + CELL / 2
            if (perCell(field)) {
                const chars = Array.from(field.value)
                for (let c = seg.from; c < seg.to; c++) {
                    const k = row * cols + c - field.offset
                    shapes.push(textShape(xOf(c) + CELL / 2, mid, chars[k], "middle", textWidth(chars[k], fsRule),
                        "color-node-regular-name", "size-font-type", fsRule, { halo: false }))
                }
            }
            else if (row * cols + seg.from === field.offset)
                shapes.push(textShape((xa + xb) / 2, mid, field.value, "middle", textWidth(field.value, fsRule),
                    "color-node-regular-name", "size-font-type", fsRule, { halo: false }))
        }

        /*  the brace (or the tick of a single cell) below the segment,
            pointing with its tip to the label  */
        const bt  = top + CELL + BRACE_GAP
        const tip = bt + BRACE_D * 2
        const xm  = (xa + xb) / 2
        const ia  = xa + 4
        const ib  = xb - 4
        if (seg.to - seg.from > 1 && ib - ia >= BRACE_D * 4)
            shapes.push(pathShape(ia, bt,
                `q 0 ${BRACE_D} ${BRACE_D} ${BRACE_D} h ${xm - ia - BRACE_D * 2} ` +
                    `q ${BRACE_D} 0 ${BRACE_D} ${BRACE_D} q 0 ${-BRACE_D} ${BRACE_D} ${-BRACE_D} ` +
                    `h ${ib - xm - BRACE_D * 2} q ${BRACE_D} 0 ${BRACE_D} ${-BRACE_D}`,
                [ 0, 0, ib - ia, BRACE_D * 2 ], "color-edge-line", 2))
        else
            shapes.push(pathShape(xm, bt, `v ${BRACE_D * 2}`, [ -1, 0, 1, BRACE_D * 2 ], "color-edge-line", 2))

        /*  the label in its tier, a lower tier connected by a leader line  */
        const tier = tierOf.get(seg)!
        const mid  = tip + LABEL_GAP + fsText * 0.45 + tier * tierH
        if (tier > 0)
            shapes.push(pathShape(xm, tip, `v ${tier * tierH}`, [ -1, 0, 1, tier * tierH ], "color-edge-line", 2))
        shapes.push(textShape(xm, mid, labelOf(field), "middle", textWidth(labelOf(field), fsText),
            "color-edge-name", "size-font-prop", fsText, { url: urlOf(field.node) }))
    }

    /*  hand over the shapes for SVG rendering (no node boxes and edges)  */
    return { nodes: [], edges: [], cx: () => 0, cy: () => 0,
        boxW: new Map(), boxH: new Map(), contentH: new Map(), polys: [], shapes }
}
