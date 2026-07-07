# restitch.ps1 — reassemble the split TypeScript compiler files from 500 KB chunks.
# Usage:  powershell -File restitch.ps1
# Output: _tsc.stitched.js and typescript.stitched.js in this folder.
# Verify against manifest.txt (SHA256 of the originals).

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$map = @{ "_tsc" = "_tsc.stitched.js"; "typescript" = "typescript.stitched.js" }

foreach ($sub in $map.Keys) {
    $dir = Join-Path $here $sub
    $out = Join-Path $here $map[$sub]
    if (Test-Path $out) { Remove-Item $out -Force }
    $fs = [System.IO.File]::Create($out)
    Get-ChildItem $dir -Filter "*.part*" | Sort-Object Name | ForEach-Object {
        $b = [System.IO.File]::ReadAllBytes($_.FullName)
        $fs.Write($b, 0, $b.Length)
    }
    $fs.Close()
    $hash = (Get-FileHash $out -Algorithm SHA256).Hash
    Write-Host ("{0} -> SHA256={1}" -f $map[$sub], $hash)
}
Write-Host "`nCompare the hashes above with manifest.txt to confirm integrity."
