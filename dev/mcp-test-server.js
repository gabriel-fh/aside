// Servidor MCP minimo para testes: uma ferramenta de leitura e uma que pede confirmacao.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'aside-teste', version: '1.0.0' });

server.registerTool(
  'somar',
  {
    description: 'Soma dois números.',
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
);

server.registerTool(
  'anotar',
  { description: 'Finge gravar uma anotação.', inputSchema: { texto: z.string() } },
  async ({ texto }) => ({ content: [{ type: 'text', text: `anotado: ${texto}` }] })
);

server.connect(new StdioServerTransport());
