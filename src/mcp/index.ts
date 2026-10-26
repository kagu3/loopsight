#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_OPTIONS } from "../core/index.js";
import { createServer } from "./server.js";

const { values } = parseArgs({ options: MCP_OPTIONS, strict: false });
const modelsDir = typeof values["models-dir"] === "string" ? values["models-dir"] : undefined;

const server = createServer({ modelsDir });
await server.connect(new StdioServerTransport());
