import { OPERATIONS, type Operation } from "./openapi.js";

export type ToolFormat = "openai" | "anthropic" | "gemini" | "json-schema";

function parameters(operation: Operation): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(operation.properties).map(([key, value]) => [key, { type: value.type, description: value.description }])),
    required: operation.required,
    additionalProperties: false,
  };
}

export function exportTools(format: ToolFormat, serverUrl = "http://127.0.0.1:4317"): unknown {
  const tools = OPERATIONS.map((operation) => {
    const description = `${operation.description} HTTP ${operation.method.toUpperCase()} ${serverUrl}${operation.path}.`;
    const schema = parameters(operation);
    if (format === "openai") return { type: "function", function: { name: operation.name, description, parameters: schema } };
    if (format === "anthropic") return { name: operation.name, description, input_schema: schema };
    if (format === "gemini") return { name: operation.name, description, parameters: schema };
    return { name: operation.name, description, inputSchema: schema };
  });
  if (format === "gemini") return { function_declarations: tools };
  return { tools };
}
