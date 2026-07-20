/**
 * make-vsix.js
 * Hand-rolled VSIX packager — no @vscode/vsce dependency required.
 * A .vsix is just a zip file with a specific internal layout that VS Code
 * recognizes. This script builds that layout directly using Node's built-in
 * zlib (no third-party zip library needed, no network access required).
 *
 * Usage:
 *   node make-vsix.js
 *
 * Requires only: node (any recent version). Run AFTER `npx tsc -p ./`
 * so the out/ directory exists with compiled .js files.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const OUT_VSIX = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);

// ── Files to include inside extension/ ──
function collectFiles(dir, baseDir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full);
    if (entry.isDirectory()) {
      collectFiles(full, baseDir, out);
    } else {
      out.push(rel);
    }
  }
}

const filesToInclude = [];
collectFiles(path.join(ROOT, "out"), ROOT, filesToInclude);
collectFiles(path.join(ROOT, "media"), ROOT, filesToInclude);
filesToInclude.push("package.json");

// Skip source maps to keep it lean (optional — comment out to keep them)
const finalFiles = filesToInclude.filter((f) => !f.endsWith(".map"));

console.log("Including files:");
finalFiles.forEach((f) => console.log("  extension/" + f));

// ── Build [Content_Types].xml ──
// A .vsix is an OPC package: EVERY file extension inside it must be declared here,
// or VS Code may reject the package or fail to serve the file. Derived from the
// files actually shipping rather than hardcoded, so a new asset type (a .css, a
// font, an image) can't silently break the package the way an undeclared .css did.
const MIME_BY_EXT = {
  json: "application/json",
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  md: "text/markdown",
  txt: "text/plain",
  map: "application/json",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
};

const shippedExts = Array.from(
  new Set(
    finalFiles
      .map((f) => path.extname(f).replace(".", "").toLowerCase())
      .filter(Boolean)
      .concat("vsixmanifest")
  )
).sort();

const unknownExts = shippedExts.filter((e) => e !== "vsixmanifest" && !MIME_BY_EXT[e]);
if (unknownExts.length) {
  console.log(`NOTE: no known MIME type for ${unknownExts.join(", ")}; using application/octet-stream`);
}

const defaults = shippedExts
  .map((e) => {
    const mime = e === "vsixmanifest" ? "text/xml" : MIME_BY_EXT[e] || "application/octet-stream";
    return `<Default Extension="${e}" ContentType="${mime}"/>`;
  })
  .join("\n");

const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaults}
</Types>`;

// ── Build extension.vsixmanifest ──
const categories = (pkg.categories || []).join(",");
const vsixManifestXml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${escapeXml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description || "")}</Description>
    <Tags></Tags>
    <Categories>${escapeXml(categories)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>`;

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Minimal ZIP writer (store + deflate, no external deps) ──
// Implements just enough of the ZIP format for VS Code to accept it.
class ZipWriter {
  constructor() {
    this.entries = [];
    this.chunks = [];
    this.offset = 0;
  }

  addFile(name, content) {
    const nameBuf = Buffer.from(name, "utf8");
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(dataBuf);
    const crc = crc32(dataBuf);

    const localHeaderOffset = this.offset;

    // Local file header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // compression = deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    this.chunks.push(localHeader, nameBuf, compressed);
    this.offset += localHeader.length + nameBuf.length + compressed.length;

    this.entries.push({
      name: nameBuf,
      crc,
      compressedSize: compressed.length,
      uncompressedSize: dataBuf.length,
      offset: localHeaderOffset,
    });
  }

  finalize() {
    const centralDirChunks = [];
    let centralDirSize = 0;

    for (const e of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(0, 12);
      central.writeUInt16LE(0, 14);
      central.writeUInt32LE(e.crc, 16);
      central.writeUInt32LE(e.compressedSize, 20);
      central.writeUInt32LE(e.uncompressedSize, 24);
      central.writeUInt16LE(e.name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(e.offset, 42);

      centralDirChunks.push(central, e.name);
      centralDirSize += central.length + e.name.length;
    }

    const centralDirOffset = this.offset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralDirSize, 12);
    eocd.writeUInt32LE(centralDirOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...this.chunks, ...centralDirChunks, eocd]);
  }
}

// CRC32 implementation (no zlib.crc32 in older Node versions, so do it manually)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Assemble the VSIX ──
const zip = new ZipWriter();
zip.addFile("[Content_Types].xml", contentTypesXml);
zip.addFile("extension.vsixmanifest", vsixManifestXml);

for (const relFile of finalFiles) {
  const fullPath = path.join(ROOT, relFile);
  const content = fs.readFileSync(fullPath);
  const zipPath = "extension/" + relFile.split(path.sep).join("/");
  zip.addFile(zipPath, content);
}

const finalBuffer = zip.finalize();
fs.writeFileSync(OUT_VSIX, finalBuffer);

console.log(`\nDone. Wrote: ${OUT_VSIX}`);
console.log(`Size: ${(finalBuffer.length / 1024).toFixed(1)} KB`);
console.log(`\nInstall with:\n  code --install-extension ${path.basename(OUT_VSIX)}`);
