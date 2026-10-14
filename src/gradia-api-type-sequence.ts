/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  internal dependencies  */
import { Graph, Edge, EdgeKind }    from "./gradia-api-model.js"
import { Config }                   from "./gradia-api-config.js"
import { Layout, Poly, ARITY_OFF, ARITY_GAP, textWidth, arrowRoom }
    from "./gradia-api-render-base.js"
import { Shape, pathShape, textShape } from "./gradia-api-render-shape.js"
import { LevelContext, rejectContainers }
    from "./gradia-api-render-container.js"
import { measureNodes, orderOf }    from "./gradia-api-render-node.js"

/*  the geometry of the lifelines and the messages  */
const COLUMN_GAP  = 60   /*  minimum gap between two participant boxes   */
const MESSAGE_GAP = 56   /*  vertical gap between two messages           */
const LOOP_H      = 40   /*  height of the loop of a self message        */
const LOOP_AIR    = 24   /*  extra width of the loop of a self message   */
const TAIL        = 32   /*  length of a lifeline below the last message */
const BAR_W       = 12   /*  width of an activation bar                  */
const BAR_SHIFT   = 6    /*  shift of a nested activation bar            */
const BAR_MIN     = 16   /*  minimum height of an activation bar         */
const CROSS       = 12   /*  half size of the cross of a destruction     */
const TIME_OFF    = 24   /*  offset of a timing beside its lifeline      */
const TIME_STEP   = 16   /*  outward step of overlapping duration marks  */
const TICK        = 8    /*  length of the ticks of a duration bracket   */
const TEXT_GAP    = 6    /*  gap between a duration bracket and its text */

/*  an activation bar (execution occurrence) of a lifeline, with its
    nesting depth, its vertical extent, and whether it is the implicit
    one of a caller, held for its still pending calls  */
interface Bar {
    id:       string
    depth:    number
    y0:       number
    y1:       number
    implicit: boolean
    pending:  number
}

/*  lay out a graph model as a sequence diagram: the nodes (in
    declaration order, or in the order of their "order" attributes) are
    the participants, drawn as regular node boxes side by side on top of
    their dashed lifelines, and the edges are the messages, drawn as
    regular edges between the lifelines in declaration order top-down
    (an edge from a node to itself as a loop on its own lifeline), where
    a synchronous call answered by a return activates its callee  */
export const render = async (graph: Graph, config: Config, level: LevelContext = {}): Promise<Layout> => {
    /*  determine the participants in their order and ensure the graph
        carries no containers, as the participants are flat  */
    const nodes = Array.from(graph.nodes.values())
        .sort((a, b) => (orderOf(a) ?? Infinity) - (orderOf(b) ?? Infinity) || 0)
    rejectContainers("sequence", nodes, level)

    /*  measure the participant boxes, unified onto the size of the
        largest one, and space the lifelines evenly, wide enough for the
        widest box and for every message name (centered, it keeps clear
        of the arity label set back from its arrow head, a creation ends
        already at the side of the box it creates, and a message spanning
        several columns shares its need among them)  */
    const { boxW, boxH, contentH } = measureNodes(nodes, config, () => config["size-node-height-scale"] / 2)
    const margin = config["size-canvas-margin"]
    const widest = nodes.reduce((w, node) => Math.max(w, boxW.get(node.id)!), 0)
    const column = new Map(nodes.map((node, i) => [ node.id, i ]))
    const label  = graph.edges.reduce((w, edge) => {
        const name  = textWidth(edge.name ?? "", config["size-font-edge"])
        const arity = edge.name !== undefined && edge.arity !== undefined ?
            2 * (ARITY_OFF + textWidth(edge.arity, config["size-font-arity"]) + ARITY_GAP) : 0
        const box   = edge.kind === "create" ? widest / 2 : 0
        const span  = Math.max(1, Math.abs(column.get(edge.source)! - column.get(edge.target)!))
        return Math.max(w, (name + arity + box + COLUMN_GAP * 1.5) / span)
    }, 0)
    const step   = Math.max(widest + COLUMN_GAP, label)
    const headH  = nodes.reduce((h, node) => Math.max(h, boxH.get(node.id)!), 0)
    for (const node of nodes) {
        boxW.set(node.id, widest)
        boxH.set(node.id, headH)
    }
    const xOf = new Map(nodes.map((node, i) => [ node.id, margin + widest / 2 + i * step ]))
    const cy  = margin + headH / 2

    /*  validate the life cycle of the participants: a participant is
        created at most once, and only by the first message it takes
        part in, and takes part in no further message once destroyed  */
    const kindOf    = (edge: Edge): EdgeKind => edge.kind ?? "sync"
    const seen      = new Set<string>()
    const destroyed = new Set<string>()
    for (const edge of graph.edges) {
        const message = `message "${edge.source}" --> "${edge.target}"`
        for (const id of [ edge.source, edge.target ])
            if (destroyed.has(id))
                throw new Error(`${message} involves participant "${id}" after its destruction`)
        if (kindOf(edge) === "create" && (edge.source === edge.target || seen.has(edge.target)))
            throw new Error(`${message} cannot create participant "${edge.target}", ` +
                "as only the first message a participant takes part in can create it")
        seen.add(edge.source)
        seen.add(edge.target)
        if (kindOf(edge) === "destroy")
            destroyed.add(edge.target)
    }

    /*  pair every synchronous call (or creation) with the return
        answering it, i.e., the next return from its callee to its
        caller, where a return answers the innermost such call still open
        on its callee and thereby leaves all calls nested inside it
        unanswered  */
    const paired   = new Set<number>()
    const answerOf = new Map<number, number>()
    const calls    = new Map(nodes.map((node) => [ node.id, new Array<number>() ]))
    graph.edges.forEach((edge, i) => {
        if (kindOf(edge) === "sync" || kindOf(edge) === "create")
            calls.get(edge.target)!.push(i)
        else if (kindOf(edge) === "return") {
            const pending = calls.get(edge.source)!
            const k       = pending.findLastIndex((c) => graph.edges[c].source === edge.target)
            if (k >= 0) {
                paired.add(pending[k])
                paired.add(i)
                answerOf.set(pending[k], i)
                pending.length = k
            }
        }
    })

    /*  ensure a duration constraint spans from a call to its return  */
    graph.edges.forEach((edge, i) => {
        if (edge.duration !== undefined && !answerOf.has(i))
            throw new Error(`message "${edge.source}" --> "${edge.target}" carries a duration, ` +
                "but is no call answered by a return")
    })

    /*  the activation bars of the lifelines: a paired call activates its
        callee until its return, and a caller without an own activation
        gets an implicit one, held until all of its calls have returned
        (and resumed by its next call, if no other activation intervened)  */
    const bars   = new Array<Bar>()
    const stacks = new Map(nodes.map((node) => [ node.id, new Array<Bar>() ]))
    const topOf  = (id: string): Bar | undefined => stacks.get(id)!.at(-1)
    const open   = (id: string, y: number, implicit: boolean): void => {
        const stack = stacks.get(id)!
        const last  = bars.findLast((bar) => bar.id === id)
        if (implicit && last !== undefined && last.implicit && stack.length === 0)
            stack.push(last)
        else {
            const bar = { id, depth: stack.length, y0: y, y1: y, implicit, pending: 0 }
            stack.push(bar)
            bars.push(bar)
        }
    }
    const close  = (id: string, y: number): void => {
        const bar = stacks.get(id)!.pop()
        if (bar !== undefined)
            bar.y1 = y
    }

    /*  the X position where a message leaves or enters a lifeline: the
        side of its innermost activation bar facing the given direction,
        or else the lifeline itself  */
    const sideOf = (id: string, dir: number): number => {
        const bar = topOf(id)
        return xOf.get(id)! + (bar !== undefined ? bar.depth * BAR_SHIFT + dir * BAR_W / 2 : 0)
    }

    /*  activate the caller of a paired call (before its message leaves),
        and resume the caller of a paired return (after its message has
        arrived), whose implicit activation ends once all its calls have
        returned  */
    const call = (edge: Edge, y: number): void => {
        if (topOf(edge.source) === undefined)
            open(edge.source, y, true)
        const caller = topOf(edge.source)!
        if (caller.implicit)
            caller.pending++
    }
    const resume = (edge: Edge, y: number): void => {
        const caller = topOf(edge.target)
        if (caller !== undefined && caller.implicit && --caller.pending <= 0)
            close(edge.target, y)
    }

    /*  the life cycle of the lifelines: a created participant has its
        box placed onto its creation message and its lifeline starting
        below it, and a destroyed participant has its lifeline (and all
        its activations) ending in a cross at its destruction  */
    const cyOf    = new Map(nodes.map((node) => [ node.id, cy ]))
    const starts  = new Map(nodes.map((node) => [ node.id, cy + headH / 2 ]))
    const ends    = new Map<string, number>()
    const crosses = new Array<[ number, number ]>()
    const destroy = (id: string, y: number): void => {
        while (topOf(id) !== undefined)
            close(id, y)
        ends.set(id, y)
        crosses.push([ xOf.get(id)!, y ])
    }

    /*  place the messages top-down, one per gap, and route each as a
        straight line between the facing sides of the lifelines or their
        activation bars (a self message as a loop, wide enough for the
        room of its arrow head, like every other edge, plus some air,
        whose call enters a nested activation of its own lifeline), where
        a creation message gets the room of the box it ends at, and a self
        destruction is drawn as its cross only  */
    const loopW  = arrowRoom(config) + LOOP_AIR
    const edges  = new Array<Edge>()
    const polys  = new Array<Poly>()
    const timing = graph.edges.map(() => ({ y: 0, y2: 0, dir: 1 }))
    let y = margin + headH + MESSAGE_GAP
    graph.edges.forEach((edge, i) => {
        const kind = kindOf(edge)
        const self = edge.source === edge.target
        if (kind === "destroy" && self) {
            timing[i] = { y, y2: y, dir: 1 }
            destroy(edge.target, y)
            y += MESSAGE_GAP
            return
        }
        if (kind === "create")
            y += headH / 2
        const [ calling, answering ] = paired.has(i) ?
            [ kind === "sync" || kind === "create", kind === "return" ] : [ false, false ]
        const dir  = self ? 1 : Math.sign(xOf.get(edge.target)! - xOf.get(edge.source)!)
        const y2   = self ? y + LOOP_H : y
        timing[i]  = { y, y2, dir }

        /*  leave the source lifeline (a call activating its caller
            first) and enter the target lifeline (a call activating its
            callee first, and a self return leaving its activation first),
            and finally end the callee activation and resume the caller  */
        if (calling)
            call(edge, y)
        const sx = sideOf(edge.source, dir)
        if (calling)
            open(edge.target, kind === "create" ? y + headH / 2 : y2, false)
        else if (answering && self)
            close(edge.source, y)
        let tx = sideOf(edge.target, self ? 1 : -dir)
        if (answering) {
            if (!self)
                close(edge.source, y)
            resume(edge, y2)
        }

        /*  end a creation at the side of the box it places, and a
            destruction at the cross it draws  */
        if (kind === "create") {
            tx = xOf.get(edge.target)! - dir * widest / 2
            cyOf.set(edge.target, y)
            starts.set(edge.target, y + headH / 2)
        }
        else if (kind === "destroy") {
            tx = xOf.get(edge.target)! - dir * CROSS
            destroy(edge.target, y)
        }
        edges.push(edge)
        if (self) {
            const rx = Math.max(sx, tx) + loopW
            polys.push([ [ sx, y ], [ rx, y ], [ rx, y2 ], [ tx, y2 ] ])
            y += LOOP_H
        }
        else
            polys.push([ [ sx, y ], [ tx, y ] ])
        y += MESSAGE_GAP + (kind === "create" ? headH / 2 : 0)
    })

    /*  draw the lifelines below the participant boxes (until their
        destruction), on top of them the activation bars, the outer ones
        first, and finally the crosses of the destructions  */
    const end    = y - MESSAGE_GAP + TAIL
    const shapes: Shape[] = nodes.map((node) => {
        const [ top, bottom ] = [ starts.get(node.id)!, ends.get(node.id) ?? end ]
        return pathShape(xOf.get(node.id)!, top, `v ${bottom - top}`, [ -1, 0, 1, bottom - top ],
            "color-node-lifeline", 2, "8 6")
    })
    for (const bar of bars) {
        const h = Math.max(bar.y1 - bar.y0, BAR_MIN)
        shapes.push(pathShape(xOf.get(bar.id)! + bar.depth * BAR_SHIFT - BAR_W / 2, bar.y0,
            `h ${BAR_W} v ${h} h ${-BAR_W} z`, [ -1, -1, BAR_W + 1, h + 1 ],
            "color-node-regular-border", 2, undefined, "color-node-regular-box"))
    }
    for (const [ px, py ] of crosses)
        shapes.push(pathShape(px - CROSS, py - CROSS, `l ${2 * CROSS} ${2 * CROSS} m 0 ${-2 * CROSS} l ${-2 * CROSS} ${2 * CROSS}`,
            [ -2, -2, 2 * CROSS + 2, 2 * CROSS + 2 ], "color-edge-line", 3))

    /*  draw the duration constraints as brackets beside the lifeline of
        the caller, on the side facing away from the callee, spanning from
        the call to the arrival of its return, with their texts beside
        them, where the shorter brackets are placed first, closest to the
        lifeline, and a bracket overlapping already placed ones on the
        same side steps outwards beyond them, i.e., beyond their lines
        and, where vertically overlapping them, their texts (whose
        outermost X position each placed bracket remembers)  */
    const fs       = config["size-font-edge"]
    const brackets = new Array<{ id: string, side: number, y0: number, y1: number, x: number, outer: number }>()
    const beyond   = (id: string, side: number, y0: number, y1: number, gap: number): number => {
        const covering = brackets.filter((b) => b.id === id && b.side === side && b.y0 <= y1 && y0 <= b.y1)
        const extent   = (b: typeof brackets[number]): number => {
            const mid = (b.y0 + b.y1) / 2
            return mid - fs <= y1 && y0 <= mid + fs ? b.outer : b.x
        }
        return covering.length === 0 ? xOf.get(id)! + side * TIME_OFF :
            covering.map(extent).reduce((m, e) => side < 0 ? Math.min(m, e) : Math.max(m, e)) + side * gap
    }
    graph.edges
        .map((edge, i) => ({ edge, side: -timing[i].dir, y0: timing[i].y, y1: timing[answerOf.get(i) ?? i].y2 }))
        .filter(({ edge }) => edge.duration !== undefined)
        .sort((a, b) => (a.y1 - a.y0) - (b.y1 - b.y0))
        .forEach(({ edge, side, y0, y1 }) => {
            const x = beyond(edge.source, side, y0, y1, TIME_STEP)
            const w = textWidth(edge.duration!, fs)
            brackets.push({ id: edge.source, side, y0, y1, x, outer: x + side * (TEXT_GAP + w) })
            shapes.push(pathShape(x - side * TICK, y0, `h ${side * TICK} v ${y1 - y0} h ${-side * TICK}`,
                [ Math.min(0, side * TICK) - 1, -1, Math.max(0, side * TICK) + 1, y1 - y0 + 1 ], "color-edge-line", 2))
            shapes.push(textShape(x + side * TEXT_GAP, (y0 + y1) / 2, edge.duration!, side < 0 ? "end" : "start",
                w, "color-edge-name", "size-font-edge", fs))
        })

    /*  draw the time constraints or observations beside the lifeline of
        the sender, on the side facing away from the receiver, and beyond
        the brackets (and their texts) covering the start of their message  */
    graph.edges.forEach((edge, i) => {
        if (edge.time === undefined)
            return
        const side = -timing[i].dir
        const x    = beyond(edge.source, side, timing[i].y, timing[i].y, TEXT_GAP)
        shapes.push(textShape(x, timing[i].y, edge.time, side < 0 ? "end" : "start",
            textWidth(edge.time, fs), "color-edge-name", "size-font-edge", fs))
    })

    /*  hand over the participants, the messages (except the self
        destructions, drawn as their crosses only, and with their names
        centered on them), and the lifelines  */
    return { nodes, edges, cx: (id) => xOf.get(id)!, cy: (id) => cyOf.get(id)!,
        boxW, boxH, contentH, polys, shapes, centered: true }
}
