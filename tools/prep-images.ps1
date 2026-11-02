# 把桌面上的原图整理进 docs/images。
#
#   pwsh -File tools/prep-images.ps1
#
# 需要 PowerShell 7（pwsh）。Windows PowerShell 5.1 读 UTF-8 无 BOM 的中文路径会乱码。
# 原图目录：$src。换图时改下面的文件名 / 宽度 / 质量。

Add-Type -AssemblyName System.Drawing

function Save-Shot {
  param([string]$Src, [string]$Dst, [int]$MaxW, [string]$Fmt, [int]$Quality)

  $img = [System.Drawing.Image]::FromFile($Src)
  $w = $img.Width
  $h = $img.Height
  if ($MaxW -gt 0 -and $w -gt $MaxW) {
    $scale = $MaxW / $w
    $w = [int][math]::Round($img.Width * $scale)
    $h = [int][math]::Round($img.Height * $scale)
  }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($img, 0, 0, $w, $h)

  if ($Fmt -eq 'jpg') {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    $bmp.Save($Dst, $codec, $ps)
    $ps.Dispose()
  } else {
    $bmp.Save($Dst, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
}

$src = 'C:\Users\白马化腾云\Desktop\照片\image'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'docs\images'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 文字多 → PNG；画面为主 → JPEG q92
Save-Shot "$src\fullscreen.png"  "$out\fullscreen.png"        1600 'png' 0
Save-Shot "$src\概览+工作台.png" "$out\overview-workbench.png" 1476 'png' 0
Save-Shot "$src\工作流+图库.png" "$out\workflow-gallery.jpg"   1476 'jpg' 92
Save-Shot "$src\frame.png"       "$out\frame.jpg"              900  'jpg' 90

foreach ($f in 'fullscreen.png', 'overview-workbench.png', 'workflow-gallery.jpg', 'frame.jpg') {
  $p = Join-Path $out $f
  '{0,-24} {1,10:N0} B' -f $f, (Get-Item $p).Length
}
