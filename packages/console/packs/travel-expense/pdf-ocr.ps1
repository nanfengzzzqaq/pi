param(
	[Parameter(Mandatory = $true)]
	[string]$Path,
	[ValidateRange(1, 8)]
	[int]$MaxPages = 4,
	[ValidateRange(800, 3000)]
	[int]$MaxDimension = 2200
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Await-WinRtOperation {
	param(
		[Parameter(Mandatory = $true)]$Operation,
		[Parameter(Mandatory = $true)][Type]$ResultType
	)
	$method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
		Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
		Select-Object -First 1
	if ($null -eq $method) { throw 'Windows Runtime AsTask<T> is unavailable' }
	$task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
	return $task.GetAwaiter().GetResult()
}

function Await-WinRtAction {
	param([Parameter(Mandatory = $true)]$Action)
	$method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
		Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
		Select-Object -First 1
	if ($null -eq $method) { throw 'Windows Runtime AsTask is unavailable' }
	$task = $method.Invoke($null, @($Action))
	[void]$task.GetAwaiter().GetResult()
}

function Invoke-OcrImageStream {
	param(
		[Parameter(Mandatory = $true)]$Stream,
		[Parameter(Mandatory = $true)]$Engine,
		[Parameter(Mandatory = $true)][int]$MaximumDimension
	)
	$bitmap = $null
	try {
		$Stream.Seek(0)
		$decoder = Await-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($Stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
		$width = [uint64]$decoder.PixelWidth
		$height = [uint64]$decoder.PixelHeight
		if ($width -eq 0 -or $height -eq 0) { throw 'Image has invalid dimensions' }
		if ($width -gt 20000 -or $height -gt 20000 -or ($width * $height) -gt 100000000) {
			throw 'Image dimensions exceed the safe OCR limit'
		}
		$largest = [Math]::Max([double]$width, [double]$height)
		$scale = [Math]::Min(1.0, $MaximumDimension / $largest)
		$transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
		$transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Round($width * $scale))
		$transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Round($height * $scale))
		$operation = $decoder.GetSoftwareBitmapAsync(
			[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
			[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
			$transform,
			[Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
			[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
		)
		$bitmap = Await-WinRtOperation $operation ([Windows.Graphics.Imaging.SoftwareBitmap])
		$result = Await-WinRtOperation ($Engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
		return $result.Text
	} finally {
		if ($null -ne $bitmap) { $bitmap.Dispose() }
	}
}

try {
	$resolved = [IO.Path]::GetFullPath($Path)
	if (-not [IO.File]::Exists($resolved)) { throw 'OCR document does not exist' }
	$extension = [IO.Path]::GetExtension($resolved).ToLowerInvariant()
	if ($extension -notin @('.pdf', '.png', '.jpg', '.jpeg')) { throw 'OCR supports PDF, PNG and JPEG only' }

	Add-Type -AssemblyName System.Runtime.WindowsRuntime
	$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
	$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
	$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
	$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
	$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
	$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
	$null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
	$null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
	$null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
	$null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
	$null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
	$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
	$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
	$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

	$file = Await-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved)) ([Windows.Storage.StorageFile])
	$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
	if ($null -eq $engine) { throw 'Windows OCR language pack is unavailable' }

	$text = [Text.StringBuilder]::new()
	$pageCount = 1
	$processed = 1
	if ($extension -eq '.pdf') {
		$pdf = Await-WinRtOperation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
		$pageCount = [int]$pdf.PageCount
		$processed = [Math]::Min($pageCount, $MaxPages)
		for ($index = 0; $index -lt $processed; $index++) {
			$page = $null
			$stream = $null
			try {
				$page = $pdf.GetPage([uint32]$index)
				$largest = [Math]::Max([double]$page.Size.Width, [double]$page.Size.Height)
				if ($largest -le 0) { throw 'PDF page has invalid dimensions' }
				# PDF page sizes are display units. Render to a bounded high resolution so
				# long invoice numbers remain readable without unbounded memory use.
				$scale = $MaxDimension / $largest
				$options = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
				$options.DestinationWidth = [uint32][Math]::Max(1, [Math]::Round([double]$page.Size.Width * $scale))
				$options.DestinationHeight = [uint32][Math]::Max(1, [Math]::Round([double]$page.Size.Height * $scale))
				$stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
				Await-WinRtAction ($page.RenderToStreamAsync($stream, $options))
				$recognized = Invoke-OcrImageStream $stream $engine $MaxDimension
				if ($text.Length -gt 0) { [void]$text.AppendLine() }
				[void]$text.Append($recognized)
			} finally {
				if ($null -ne $stream) { $stream.Dispose() }
				if ($null -ne $page) { $page.Dispose() }
			}
		}
	} else {
		$stream = $null
		try {
			$stream = Await-WinRtOperation ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
			[void]$text.Append((Invoke-OcrImageStream $stream $engine $MaxDimension))
		} finally {
			if ($null -ne $stream) { $stream.Dispose() }
		}
	}

	[Console]::Out.WriteLine((@{
		ok = $true
		pageCount = $pageCount
		processedPages = $processed
		truncated = ($extension -eq '.pdf' -and $pageCount -gt $processed)
		text = $text.ToString()
	} | ConvertTo-Json -Compress))
} catch {
	[Console]::Out.WriteLine((@{
		ok = $false
		error = $_.Exception.Message
	} | ConvertTo-Json -Compress))
	exit 1
}
