/**
 * Generate typed Rust and TypeScript clients from the Codama IDL.
 *
 * Usage:
 *   bun scripts/generate-clients.ts
 *
 * Prerequisites:
 *   1. Generate IDL first: cargo check -p ika-system-program --features idl
 *   2. Install deps: bun install
 */

import * as fs from "fs";
import * as path from "path";
import { createIkaSystemCodamaBuilder } from "./lib/ika-system-codama-builder";

const rootDir = path.resolve(__dirname, "..");
const idlDir = path.join(rootDir, "idl");
const rustClientsDir = path.join(rootDir, "clients", "rust", "src", "generated");
const typescriptClientsDir = path.join(
  rootDir,
  "clients",
  "typescript",
  "src",
  "generated",
);

async function main() {
  // Load IDL
  const idlPath = path.join(idlDir, "ika_system_program.json");
  if (!fs.existsSync(idlPath)) {
    console.error(
      `IDL not found at ${idlPath}. Run: cargo check -p ika-system-program --features idl`,
    );
    process.exit(1);
  }

  const idlJson = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  console.log("Loaded IDL from", idlPath);

  // Build Codama AST with transformations
  const codama = createIkaSystemCodamaBuilder(idlJson).build();

  // Render Rust client
  console.log("Generating Rust client...");
  const { renderVisitor: renderRustVisitor } = await import(
    "@codama/renderers-rust"
  );
  codama.accept(
    renderRustVisitor(rustClientsDir, {
      deleteFolderBeforeRendering: true,
      formatCode: true,
    }),
  );
  console.log("Rust client written to", rustClientsDir);

  // Render TypeScript client
  console.log("Generating TypeScript client...");
  const { renderVisitor: renderJsVisitor } = await import(
    "@codama/renderers-js"
  );
  await codama.accept(
    renderJsVisitor(typescriptClientsDir, {
      deleteFolderBeforeRendering: true,
      formatCode: true,
    }),
  );
  console.log("TypeScript client written to", typescriptClientsDir);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
