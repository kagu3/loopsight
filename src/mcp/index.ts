#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const { values } = parseArgs({ options: { "models-dir": { type: "string" } }, strict: false });
const modelsDir = typeof values["models-dir"] === "string" ? values["models-dir"] : undefined;

const server = createServer({ modelsDir });
await server.connect(new StdioServerTransport());
