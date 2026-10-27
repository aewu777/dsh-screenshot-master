/**
 * Tool-definition helper.
 *
 * The registry accepts a plain object shaped like `ToolDefinition`
 * (`name`, `description`, `parameters`, `output: { schema, render }`,
 * `execute`). This module builds one, adds argument validation so a bad call is
 * rejected with an actionable message before any native work starts, and keeps
 * the plugin free of peer imports so it can be installed as a profile bundle
 * without resolving the harness packages.
 */

import { ScreenshotError } from './errors.js'

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'

export interface JsonSchemaNode {
  type?: JsonSchemaType
  description?: string
  title?: string
  enum?: readonly (string | number | boolean | null)[]
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  default?: unknown
  minimum?: number
}

/** A content part the model receives. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

export type ContentBlock = TextContentBlock

export interface ToolRunContext {
  readonly signal?: AbortSignal
  readonly callId?: string
}

export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: unknown): ContentBlock[]
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

export interface DefineToolOptions {
  name: string
  description: string
  parameters?: JsonSchemaNode
  outputSchema?: JsonSchemaNode
  render?(value: unknown, args: unknown): string
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

const EMPTY_OBJECT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

function describeType(type: JsonSchemaType): string {
  return type === 'integer' ? 'an integer' : `a ${type}`
}

function validateNode(
  schema: JsonSchemaNode,
  value: unknown,
  at: string,
  violations: string[],
): void {
  const label = at || 'arguments'

  if (schema.oneOf && schema.oneOf.length > 0) {
    const matches = schema.oneOf.some((branch) => {
      const local: string[] = []
      validateNode(branch, value, at, local)
      return local.length === 0
    })
    if (!matches) {
      violations.push(
        `${label} must match one of: ${schema.oneOf.map((branch) => String(branch.type ?? 'value')).join(', ')}`,
      )
      return
    }
  }

  if (schema.type && !matchesType(value, schema.type)) {
    violations.push(`${label} must be ${describeType(schema.type)}`)
    return
  }

  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null)) {
    violations.push(`${label} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }

  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    violations.push(`${label} must be at least ${schema.minimum}`)
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => {
      validateNode(schema.items!, entry, `${label}[${index}]`, violations)
    })
  }

  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (record[key] === undefined || record[key] === null) {
        violations.push(`${key} is required`)
      }
    }
    const properties = schema.properties ?? {}
    for (const [key, child] of Object.entries(properties)) {
      if (record[key] !== undefined && record[key] !== null) {
        validateNode(child, record[key], label === 'arguments' ? key : `${label}.${key}`, violations)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) violations.push(`${key} is not a supported parameter`)
      }
    }
  }
}

/** Return a list of human-readable violations; empty means the call is valid. */
export function validateArguments(schema: JsonSchemaNode, args: unknown): string[] {
  const violations: string[] = []
  validateNode(schema, args ?? {}, '', violations)
  return violations
}

/**
 * Build a registry-ready tool definition.
 *
 * `execute` receives validated, non-null arguments; a call that fails validation
 * throws `INVALID_ARGUMENT` before the body runs.
 */
export function defineTool(options: DefineToolOptions): ToolDefinition {
  const parameters = options.parameters ?? EMPTY_OBJECT_SCHEMA
  const outputSchema = options.outputSchema ?? EMPTY_OBJECT_SCHEMA

  const definition: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        const text =
          typeof value === 'string'
            ? value
            : (options.render?.(value, args) ?? JSON.stringify(value ?? null, null, 2))
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const candidate = args ?? {}
      const violations = validateArguments(parameters, candidate)
      if (violations.length > 0) {
        throw new ScreenshotError('INVALID_ARGUMENT', `Invalid arguments: ${violations.join('; ')}.`)
      }
      return options.execute(candidate as Record<string, unknown>, exec ?? {})
    },
  }

  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs
  if (options.isConcurrencySafe) definition.isConcurrencySafe = options.isConcurrencySafe

  return definition
}
