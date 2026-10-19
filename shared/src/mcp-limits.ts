// Limits for connected tools (MCP): see the comment above the MCP types in index.ts. Kept in their own file so mcp-text.ts can use them without a circular import.

export const MCP_LIMITS = {
  /** Servers per person, characters in a server name, tools handed to the AI in all. */
  servers: 10,
  nameChars: 32,
  tools: 50,
  toolNameChars: 64,
  /** A tool's description (cut) and its input schema (a tool with a bigger one is left out), in characters. */
  descriptionChars: 1_000,
  schemaChars: 8_192,
  /** One call: arguments the AI may send (JSON characters), result text kept, how long to wait for it. */
  argChars: 100_000,
  resultChars: 50_000,
  callDefaultMs: 60_000,
  /** Calls one AI answer may make, and calls one person's tools may take per ten minutes. */
  runCalls: 25,
  windowCalls: 120,
  /** Adding a server: parts of the command line, characters in one, environment variables, characters in one value. */
  commandParts: 32,
  partChars: 500,
  envVars: 20,
  envValueChars: 2_000,
} as const;
