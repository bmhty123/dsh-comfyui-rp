Add-Type -AssemblyName System.Drawing

function Convert-Shot {
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
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
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

  $g.Dispose()
  $bmp.Dispose()
  $img.Dispose()
}

$srcDir = 'C:\Users\白马化腾云\Desktop\照片\image'
$outDir = 'F:\deepseek harness 工作区\DSH插件\DSH-AIRP-COMFY\docs\images'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# UI 文字多的截图保留 PNG（本来就小）
Convert-Shot "$srcDir\overview.png"  "$outDir\overview.png"  0    'png' 0
Convert-Shot "$srcDir\workbench.png" "$outDir\workbench.png" 0    'png' 0
Convert-Shot "$srcDir\workflow.png"  "$outDir\workflow.png"  0    'png' 0

# 画面为主的三张转 JPEG q90，控制仓库和 npm 包体积
Convert-Shot "$srcDir\frame.png"      "$outDir\frame.jpg"      900  'jpg' 90
Convert-Shot "$srcDir\gallery.png"    "$outDir\gallery.jpg"    900  'jpg' 90
Convert-Shot "$srcDir\fullscreen.png" "$outDir\fullscreen.jpg" 1600 'jpg' 88

Get-ChildItem $outDir -File | Sort-Object Name |
  ForEach-Object { '{0,-16} {1,8:N0} B' -f $_.Name, $_.Length }
