import { z } from "zod"
import { TargetTypeSchema } from "./target.js"

/**
 * Comparison operators usable in filter leaves and rubric conditions.
 *
 * `within` is geo (point + radius or polygon), `intersects` is set overlap,
 * `contains` is substring for strings and membership for arrays.
 */
export const OperatorSchema = z.enum([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "nin",
  "contains",
  "intersects",
  "exists",
  "within",
])

export type Operator = z.infer<typeof OperatorSchema>

export const OPERATORS = OperatorSchema.options

/** Operators that take no value (`exists` is unary over the key's presence). */
export const UNARY_OPERATORS: readonly Operator[] = ["exists"]

/** Operators whose value must be an array. */
export const ARRAY_OPERATORS: readonly Operator[] = ["in", "nin", "intersects"]

const LeafFilterSchema = z.object({
  op: OperatorSchema,
  /**
   * Dotted path into the entity's flattened signal space, e.g. "web.presence.has_website"
   * or "core.address.postal_code". Validated against the filter registry at runtime -
   * the registry is generated from the signal providers, not hardcoded here.
   */
  key: z.string().min(1),
  value: z.unknown(),
})

export type LeafFilter = {
  op: Operator
  key: string
  value: unknown
}

export type FilterNode =
  { op: "and" | "or"; children: FilterNode[] } | { op: "not"; child: FilterNode } | LeafFilter

/**
 * Recursive AND/OR/NOT tree. Zod needs the explicit type annotation plus a getter
 * to tie the knot on the self-reference.
 */
export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.object({
      op: z.enum(["and", "or"]),
      // An empty AND is the identity element (MATCH_ALL) - a search with no filters
      // is legal and means "everything the adapters return".
      children: z.array(FilterNodeSchema),
    }),
    z.object({
      op: z.literal("not"),
      child: FilterNodeSchema,
    }),
    LeafFilterSchema,
  ])
)

export const SearchSpecSchema = z.object({
  targetType: TargetTypeSchema,
  filters: FilterNodeSchema,
  limit: z.number().int().positive().max(10_000).optional(),
  /** Empty or omitted means the planner picks the adapters. */
  sources: z.array(z.string().min(1)).optional(),
})

export type SearchSpec = z.infer<typeof SearchSpecSchema>

/** Narrowing helpers - `op` alone does not discriminate the union for TypeScript. */
export function isBranchNode(
  node: FilterNode
): node is { op: "and" | "or"; children: FilterNode[] } {
  return (node.op === "and" || node.op === "or") && "children" in node
}

export function isNotNode(node: FilterNode): node is { op: "not"; child: FilterNode } {
  return node.op === "not" && "child" in node
}

export function isLeafNode(node: FilterNode): node is LeafFilter {
  return "key" in node
}

/** Walks a filter tree and returns every leaf key referenced. Used by the planner. */
export function collectFilterKeys(node: FilterNode): string[] {
  if (isBranchNode(node)) {
    return node.children.flatMap(collectFilterKeys)
  }
  if (isNotNode(node)) {
    return collectFilterKeys(node.child)
  }
  return isLeafNode(node) ? [node.key] : []
}

/** A filter tree that matches everything - the identity element for AND. */
export const MATCH_ALL: FilterNode = { op: "and", children: [] }
