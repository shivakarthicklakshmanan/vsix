"""
make_vsix.py
============
Packages the TechMind Studio VS Code extension into a .vsix file.

Requirements : Python 3 (any version >= 3.6). Zero pip installs.
               Uses only: zipfile, pathlib, textwrap, datetime — all stdlib.

Usage
-----
    python make_vsix.py

Run from inside the techmind-vscode-project/ folder (the one that contains
package.json, out/, media/).  Produces:

    techmind-studio-1.0.0.vsix

in the same folder.  Install it in VS Code via:
    Extensions panel -> ... -> Install from VSIX...

What this script does
---------------------
A .vsix file is just a ZIP archive with a specific internal layout:

    [Content_Types].xml          <- tells VS Code what MIME types are inside
    extension.vsixmanifest       <- the extension metadata / manifest
    extension/
        package.json             <- your extension's manifest
        out/
            agentPanel.js
            extension.js
            llmRegistry.js
            sidebarProviders.js
            workflows.js
        media/
            icon.svg

This script builds that ZIP directly using Python's built-in zipfile module.
No vsce, no Node, no npm, no shell scripts.
"""

import zipfile
import json
import os
import sys
from pathlib import Path
from datetime import datetime

# ── locate project root (wherever this script lives) ──────────────────────────
ROOT = Path(__file__).parent.resolve()

# ── read version from package.json ────────────────────────────────────────────
pkg_path = ROOT / "package.json"
if not pkg_path.exists():
    print(f"ERROR: package.json not found at {pkg_path}")
    print("Make sure you run this script from inside the techmind-vscode-project/ folder.")
    sys.exit(1)

with open(pkg_path, encoding="utf-8") as f:
    pkg = json.load(f)

name      = pkg["name"]           # techmind-studio
version   = pkg["version"]        # 1.0.0
publisher = pkg["publisher"]      # internal-airgapped
display   = pkg.get("displayName", name)
desc      = pkg.get("description", "")
engine    = pkg.get("engines", {}).get("vscode", "^1.85.0")
cats      = ",".join(pkg.get("categories", []))

OUT_VSIX = ROOT / f"{name}-{version}.vsix"

# ── files to include (relative to ROOT, zipped under extension/) ──────────────
# Source maps are excluded to keep the package lean.
FILES_TO_INCLUDE = []

out_dir = ROOT / "out"
if not out_dir.exists():
    print("ERROR: out/ directory not found.")
    print("This means the TypeScript compile step hasn't run yet.")
    print("On a machine with Node: run  node node_modules/typescript/lib/tsc.js -p ./")
    print("Or ask your team to run the build once on an internet-connected machine")
    print("and include the out/ folder in the zip you carry across the airgap.")
    sys.exit(1)

for f in sorted(out_dir.rglob("*")):
    if f.is_file() and not f.name.endswith(".map"):
        FILES_TO_INCLUDE.append(f)

media_dir = ROOT / "media"
if media_dir.exists():
    for f in sorted(media_dir.rglob("*")):
        if f.is_file():
            FILES_TO_INCLUDE.append(f)

FILES_TO_INCLUDE.append(ROOT / "package.json")

print(f"TechMind Studio — Python VSIX Packager")
print(f"----------------------------------------")
print(f"Extension : {display} v{version}")
print(f"Publisher : {publisher}")
print(f"Output    : {OUT_VSIX.name}")
print()
print("Files to include:")
for f in FILES_TO_INCLUDE:
    rel = f.relative_to(ROOT)
    print(f"  extension/{rel.as_posix()}")

# ── XML helpers ───────────────────────────────────────────────────────────────
def xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;")
             .replace('"', "&quot;"))

# ── [Content_Types].xml ───────────────────────────────────────────────────────
CONTENT_TYPES = """\
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/>
<Default Extension="js" ContentType="application/javascript"/>
<Default Extension="svg" ContentType="image/svg+xml"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>"""

# ── extension.vsixmanifest ────────────────────────────────────────────────────
VSIX_MANIFEST = f"""\
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{xml_escape(name)}" Version="{xml_escape(version)}" Publisher="{xml_escape(publisher)}" />
    <DisplayName>{xml_escape(display)}</DisplayName>
    <Description xml:space="preserve">{xml_escape(desc)}</Description>
    <Tags></Tags>
    <Categories>{xml_escape(cats)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{xml_escape(engine)}" />
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
</PackageManifest>"""

# ── build the ZIP ─────────────────────────────────────────────────────────────
print()
print("Packaging...")

with zipfile.ZipFile(OUT_VSIX, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    # 1. metadata files at the root of the ZIP (not inside extension/)
    zf.writestr("[Content_Types].xml", CONTENT_TYPES)
    zf.writestr("extension.vsixmanifest", VSIX_MANIFEST)

    # 2. extension files under extension/
    for abs_path in FILES_TO_INCLUDE:
        rel = abs_path.relative_to(ROOT)
        zip_path = "extension/" + rel.as_posix()
        zf.write(abs_path, zip_path)

size_kb = OUT_VSIX.stat().st_size / 1024

print()
print(f"Done. Wrote: {OUT_VSIX}")
print(f"Size : {size_kb:.1f} KB")
print()
print("Next step — install in VS Code:")
print("  Extensions panel  ->  ...  ->  Install from VSIX...")
print(f"  Select: {OUT_VSIX.name}")
