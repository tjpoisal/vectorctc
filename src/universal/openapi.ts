export interface Operation {
  name: string;
  method: "get" | "post";
  path: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

export const OPERATIONS: Operation[] = [
  {
    name: "ctc_check",
    method: "post",
    path: "/v1/check",
    description: "Run RunwayGateAnalyzer on a file. Pass content to check a proposal. Omit content to check the file on disk. A hold is ctc.hold.v1.",
    properties: {
      path: { type: "string", description: "Repo-relative path." },
      content: { type: "string", description: "Proposed contents. Omit to read the file from disk." },
    },
    required: ["path"],
  },
  {
    name: "ctc_write",
    method: "post",
    path: "/v1/write",
    description: "Write a file only when the blueprint flight plan, or the milestone ceiling, and RunwayGateAnalyzer all pass.",
    properties: {
      path: { type: "string", description: "Repo-relative path." },
      content: { type: "string", description: "Full file contents." },
      sessionId: { type: "string", description: "Optional session. A new id clears a RED lock." },
    },
    required: ["path", "content"],
  },
  {
    name: "ctc_patch",
    method: "post",
    path: "/v1/patch",
    description: "Apply one unique literal search/replace, then the same gate as ctc_write. $ is literal.",
    properties: {
      path: { type: "string", description: "Repo-relative path." },
      hunks: { type: "array", description: "Objects with search and replace strings. The search must match once." },
      sessionId: { type: "string", description: "Optional session id." },
    },
    required: ["path", "hunks"],
  },
  {
    name: "ctc_read",
    method: "post",
    path: "/v1/read",
    description: "Read a file through the radar. The second identical read is yellow. The third locks red.",
    properties: {
      path: { type: "string", description: "Repo-relative path." },
      startLine: { type: "integer", description: "Optional 1-based start line." },
      endLine: { type: "integer", description: "Optional 1-based end line." },
      sessionId: { type: "string", description: "Optional session id." },
    },
    required: ["path"],
  },
  {
    name: "ctc_blueprint",
    method: "get",
    path: "/v1/blueprint",
    description: "Return the saved pre-flight blueprint, or null when the project has not been onboarded.",
    properties: {},
    required: [],
  },
  {
    name: "ctc_status",
    method: "get",
    path: "/v1/status",
    description: "Return the milestone, whether a RED lock is set, and whether a task flight plan is active.",
    properties: {},
    required: [],
  },
];

function schemaFor(operation: Operation): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(Object.entries(operation.properties).map(([key, value]) => [key, { type: value.type, description: value.description }])),
    required: operation.required,
  };
}

export function openApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const operation of OPERATIONS) {
    const body = operation.method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: schemaFor(operation) } } } }
      : {};
    paths[operation.path] = {
      [operation.method]: {
        operationId: operation.name,
        summary: operation.description,
        ...body,
        responses: {
          "200": { description: "Cleared, or a GET payload." },
          "409": { description: "Hold. Body is ctc.hold.v1 or ctc.write.v1 with cleared false." },
          "400": { description: "Request error." },
          "401": { description: "Bearer token required." },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Code Traffic Control",
      version: "0.1.0",
      description: "Local gate in front of the filesystem. The blueprint flight plan and RunwayGateAnalyzer are the source of truth.",
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
      },
    },
  };
}
