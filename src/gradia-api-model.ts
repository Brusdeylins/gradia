/*
**  Gradia -- Object Graph Diagram Rendering
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  a node attribute as a key/value pair  */
export interface Attr {
    key:    string
    val:    string
}

/*  a graph node with its label and attributes  */
export interface Node {
    id:     string
    name:   string
    attrs:  Attr[]
}

/*  the kinds of an edge, i.e., of a message in a "sequence" diagram
    (a synchronous call, an asynchronous message, a return, or the
    creation or destruction of its receiver)  */
export type EdgeKind = "sync" | "async" | "return" | "create" | "destroy"
export const edgeKinds: EdgeKind[] = [ "sync", "async", "return", "create", "destroy" ]

/*  a directed graph edge with optional name, arity, kind, and timing
    (a duration constraint up to its return and a time constraint or
    observation at its start, in a "sequence" diagram)  */
export interface Edge {
    source:    string
    target:    string
    name?:     string
    arity?:    string
    kind?:     EdgeKind
    duration?: string
    time?:     string
}

/*  the graph model of nodes (keyed by their id) and edges  */
export interface Graph {
    nodes:  Map<string, Node>
    edges:  Edge[]
}

