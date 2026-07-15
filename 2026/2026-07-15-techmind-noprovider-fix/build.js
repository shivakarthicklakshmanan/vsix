/**
 * build.js
 * Pure Node.js build runner — no shell script, no bash, no .sh execution.
 * Does exactly what build-offline.sh did, but as a plain Node program.
 *
 * Usage (from inside techmind-vscode-project/):
 *   node build.js
 *
 * Requires only: node + the pre-fetched node_modules (from techmind-offline-deps.zip).
 * No network access used.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

function step(n, total, label) {
  console.log(`\n[${n}/${total}] ${label}`);
}

function run(cmd, args) {
  console.log("  > " + cmd + " " + args.join(" "));
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
}

try {
  step(1, 3, "Compiling TypeScript...");
  // Resolve tsc via the typescript package's own entrypoint rather than the
  // node_modules/.bin symlink — some zip tools (notably plain `zip` without
  // -y) dereference symlinks into broken stand-ins when packaging, which
  // breaks the .bin shim's relative require() of ../lib/tsc.js. Going
  // straight to node_modules/typescript/lib/tsc.js avoids that entirely.
  const tscLib = path.join(ROOT, "node_modules", "typescript", "lib", "tsc.js");

  if (fs.existsSync(tscLib)) {
    run(process.execPath, [tscLib, "-p", "./"]);
  } else {
    // Older typescript versions/layouts: try the bin entrypoint directly
    const tscBin = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
    if (fs.existsSync(tscBin)) {
      run(process.execPath, [tscBin, "-p", "./"]);
    } else {
      console.error("ERROR: could not locate the TypeScript compiler under node_modules/typescript.");
      console.error("Checked: " + tscLib + " and " + tscBin);
      process.exit(1);
    }
  }

  step(2, 3, "Verifying compiled output...");
  const compiledEntry = path.join(ROOT, "out", "extension.js");
  if (!fs.existsSync(compiledEntry)) {
    console.error("ERROR: out/extension.js not found. Compile failed.");
    process.exit(1);
  }
  console.log("  OK: out/extension.js present");

  step(3, 3, "Packaging .vsix (no vsce, no network)...");
  run(process.execPath, [path.join(ROOT, "make-vsix.js")]);

  console.log("\nBuild complete. Install with:");
  console.log("  code --install-extension techmind-studio-1.0.0.vsix");
  console.log("Or via VS Code UI: Extensions panel -> ... -> Install from VSIX");
} catch (err) {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
}
