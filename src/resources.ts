import type { McpServer } from "@modelcontextprotocol/server";
import { DOCUMENT_TYPES, EVERYDAY_TERMS } from "./doc-types.js";
import { summarizeWarehouse } from "./summarize.js";
import { cachedWarehouses, describeError, type ToolContext } from "./tools/shared.js";

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "document-types",
    "metakocka://document-types",
    {
      title: "Metakocka document types",
      description: "Document type codes used by this server, with their Slovenian names as shown in Metakocka, and everyday Slovenian words mapped to the type they usually mean.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ types: DOCUMENT_TYPES, everyday_terms: EVERYDAY_TERMS }, null, 2) }],
    }),
  );

  server.registerResource(
    "warehouses",
    "metakocka://warehouses",
    {
      title: "Warehouses",
      description: "The company's warehouses (id, mark, name, address).",
      mimeType: "application/json",
    },
    async (uri) => {
      let text: string;
      try {
        text = JSON.stringify((await cachedWarehouses(ctx)).map(summarizeWarehouse), null, 2);
      } catch (error) {
        text = JSON.stringify({ error: describeError(error) });
      }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );
}
