import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest
} from "@modelcontextprotocol/sdk/types.js";
import { findToolByName, toolDefinitions } from "./lib/tools.js";

/** Some clients pad a call to a tool with no required arguments with a dummy key such as
 * `_placeholder`. No wSpec tool has an underscore-prefixed parameter, so drop them here; a real
 * typo like `hook: false` is still rejected by the tool's own strict schema. */
function withoutPlaceholderKeys(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith("_")));
}

export async function startServer() {
  const server = new Server(
    {
      name: "wspec-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => {
    return {
      tools: toolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const tool = findToolByName(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }]
      };
    }

    try {
      const result = tool.run(withoutPlaceholderKeys(request.params.arguments ?? {}));
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: message }]
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
