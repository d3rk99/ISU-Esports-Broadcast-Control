// Captures are normalized to the expected 1920x1080 grid (all ROIs are defined there).
// Accept any source with the same aspect ratio (e.g. 1280x720, 2560x1440, 3840x2160) and
// scale it; only reject sources whose shape would stretch the HUD.
const ASPECT_TOLERANCE = 0.01;
const MIN_CAPTURE_HEIGHT = 720;

function captureSizeCheck(width, height, expectedWidth, expectedHeight, tolerancePixels) {
  const widthDifference = Math.abs(width - expectedWidth);
  const heightDifference = Math.abs(height - expectedHeight);
  if (widthDifference <= tolerancePixels && heightDifference <= tolerancePixels) {
    return { ok: true, normalized: widthDifference !== 0 || heightDifference !== 0 };
  }
  const expectedAspect = expectedWidth / expectedHeight;
  const aspect = width / height;
  const sameShape = Math.abs(aspect - expectedAspect) / expectedAspect <= ASPECT_TOLERANCE;
  if (sameShape && height >= MIN_CAPTURE_HEIGHT) return { ok: true, normalized: true, scaled: true };
  return {
    ok: false,
    message: sameShape
      ? `VALORANT capture is ${width}×${height}; below ${MIN_CAPTURE_HEIGHT}p the HUD text is too small to read`
      : `VALORANT capture is ${width}×${height}; use a 16:9 source (1920×1080 recommended)`
  };
}

function otsuThreshold(gray) {
  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value] += 1;
  let totalSum = 0;
  for (let index = 0; index < 256; index += 1) totalSum += index * histogram[index];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let index = 0; index < 256; index += 1) {
    backgroundWeight += histogram[index];
    if (!backgroundWeight) continue;
    const foregroundWeight = gray.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += index * histogram[index];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = index;
    }
  }
  return threshold;
}

function preprocessNativeImage(nativeImageApi, image, options = {}) {
  const scale = Math.max(1, Math.min(6, Number(options.scale) || 3));
  const size = image.getSize();
  const resized = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'best' });
  const outputSize = resized.getSize();
  const bitmap = Buffer.from(resized.toBitmap());
  const gray = new Uint8Array(outputSize.width * outputSize.height);
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const offset = pixel * 4;
    gray[pixel] = Math.round(bitmap[offset] * 0.114 + bitmap[offset + 1] * 0.587 + bitmap[offset + 2] * 0.299);
  }
  const threshold = options.threshold === 'otsu' ? otsuThreshold(gray) : Number(options.threshold) || 127;
  let bright = 0;
  for (const value of gray) if (value > threshold) bright += 1;
  const invert = options.invert === true || (options.invert === 'auto' && bright < gray.length / 2);
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const foreground = invert ? gray[pixel] > threshold : gray[pixel] <= threshold;
    const value = foreground ? 0 : 255;
    const offset = pixel * 4;
    bitmap[offset] = value;
    bitmap[offset + 1] = value;
    bitmap[offset + 2] = value;
    bitmap[offset + 3] = 255;
  }
  // Optional horizontal shear to undo italic text (Overwatch names use BigNoodleTooOblique,
  // slanted ~0.21). Rows above the middle shift left and rows below shift right; the result is
  // upright, which tesseract reads far better. Background fill = white.
  const shear = Number(options.shear) || 0;
  if (shear) {
    const { width, height } = outputSize;
    const out = Buffer.alloc(bitmap.length, 255);
    for (let y = 0; y < height; y += 1) {
      const shift = Math.round(shear * (y - height / 2));
      for (let x = 0; x < width; x += 1) {
        const sx = x - shift;
        if (sx < 0 || sx >= width) continue;
        bitmap.copy(out, (y * width + x) * 4, (y * width + sx) * 4, (y * width + sx) * 4 + 4);
      }
    }
    return nativeImageApi.createFromBitmap(out, outputSize);
  }
  return nativeImageApi.createFromBitmap(bitmap, outputSize);
}

// Luminance (0-255) of one pixel on the normalized frame. The BGRA bitmap is cached on the
// frame so many lookups per sweep (e.g. Overwatch ult rings) cost one copy.
const frameBitmaps = new WeakMap();
// RGB of one pixel on the normalized frame (same cached bitmap as frameLuminance).
function frameRgb(frame, x, y) {
  frameLuminance(frame, 0, 0); // fills the cache
  const cached = frameBitmaps.get(frame);
  if (x < 0 || y < 0 || x >= cached.width || y >= cached.height) return [0, 0, 0];
  const o = (y * cached.width + x) * 4;
  return [cached.bitmap[o + 2], cached.bitmap[o + 1], cached.bitmap[o]];
}

function frameLuminance(frame, x, y) {
  let cached = frameBitmaps.get(frame);
  if (!cached) {
    const size = frame.image.getSize();
    cached = { width: size.width, height: size.height, bitmap: Buffer.from(frame.image.toBitmap()) };
    frameBitmaps.set(frame, cached);
  }
  if (x < 0 || y < 0 || x >= cached.width || y >= cached.height) return 0;
  const o = (y * cached.width + x) * 4;
  return Math.round(cached.bitmap[o] * 0.114 + cached.bitmap[o + 1] * 0.587 + cached.bitmap[o + 2] * 0.299);
}

function redPixelRatio(image) {
  const size = image.getSize();
  const bitmap = Buffer.from(image.toBitmap());
  let red = 0;
  let visible = 0;
  for (let pixel = 0; pixel < size.width * size.height; pixel += 1) {
    const offset = pixel * 4;
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const redChannel = bitmap[offset + 2];
    const alpha = bitmap[offset + 3];
    if (alpha < 32) continue;
    visible += 1;
    if (redChannel >= 145 && redChannel > green * 1.45 && redChannel > blue * 1.45) red += 1;
  }
  return visible ? red / visible : 0;
}

class ValorantWindowCapture {
  constructor({ desktopCapturer, nativeImage, expectedWidth = 1920, expectedHeight = 1080, sizeTolerancePixels = 2 } = {}) {
    this.desktopCapturer = desktopCapturer;
    this.nativeImage = nativeImage;
    this.expectedWidth = expectedWidth;
    this.expectedHeight = expectedHeight;
    this.sizeTolerancePixels = Math.max(0, Number(sizeTolerancePixels) || 0);
  }

  async listWindows() {
    const sources = await this.desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });
    return sources.map((source) => ({ id: source.id, name: source.name }));
  }

  async capture(windowName = 'VALORANT') {
    const sources = await this.desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: this.expectedWidth, height: this.expectedHeight },
      fetchWindowIcons: false
    });
    const needle = String(windowName || 'VALORANT').trim().toLowerCase();
    const source = sources.find((candidate) => candidate.name.toLowerCase() === needle)
      || sources.find((candidate) => candidate.name.toLowerCase().includes(needle));
    if (!source) {
      const error = new Error(`Window containing “${windowName || 'VALORANT'}” was not found`);
      error.code = 'WINDOW_NOT_FOUND';
      throw error;
    }
    const size = source.thumbnail.getSize();
    if (size.width === 0 || size.height === 0) {
      const error = new Error(`The selected “${source.name}” window returned an empty frame; keep it restored while capture retries`);
      error.code = 'CAPTURE_EMPTY';
      error.details = { width: size.width, height: size.height, sourceId: source.id, sourceName: source.name };
      throw error;
    }
    const sizeCheck = captureSizeCheck(size.width, size.height, this.expectedWidth, this.expectedHeight, this.sizeTolerancePixels);
    if (!sizeCheck.ok) {
      const error = new Error(sizeCheck.message);
      error.code = 'CAPTURE_SIZE';
      error.details = {
        width: size.width,
        height: size.height,
        expectedWidth: this.expectedWidth,
        expectedHeight: this.expectedHeight,
        tolerance: this.sizeTolerancePixels
      };
      throw error;
    }
    const normalized = sizeCheck.normalized;
    const image = normalized
      ? source.thumbnail.resize({ width: this.expectedWidth, height: this.expectedHeight, quality: 'best' })
      : source.thumbnail;
    return {
      sourceId: source.id,
      sourceName: source.name,
      image,
      width: this.expectedWidth,
      height: this.expectedHeight,
      sourceWidth: size.width,
      sourceHeight: size.height,
      normalized,
      backend: 'electron-desktop-capturer',
      capturedAt: Date.now()
    };
  }

  crop(frame, roi, preprocess = {}) {
    const image = frame.image.crop({ x: roi.x, y: roi.y, width: roi.w, height: roi.h });
    const processed = preprocessNativeImage(this.nativeImage, image, preprocess);
    return {
      image: processed.toPNG(),
      rawDataUrl: image.toDataURL(),
      processedDataUrl: processed.toDataURL()
    };
  }

  redRatio(frame, roi) {
    return redPixelRatio(frame.image.crop({ x: roi.x, y: roi.y, width: roi.w, height: roi.h }));
  }

  luminance(frame, x, y) { return frameLuminance(frame, x, y); }

  rgb(frame, x, y) { return frameRgb(frame, x, y); }

  snapshot(frame, fields) {
    const crops = {};
    for (const [id, field] of Object.entries(fields)) crops[id] = this.crop(frame, field.roi, field.preprocess);
    return {
      capturedAt: frame.capturedAt,
      sourceName: frame.sourceName,
      backend: frame.backend || 'electron-desktop-capturer',
      width: frame.width,
      height: frame.height,
      sourceWidth: frame.sourceWidth || frame.width,
      sourceHeight: frame.sourceHeight || frame.height,
      normalized: Boolean(frame.normalized),
      frameDataUrl: frame.image.toDataURL(),
      crops: Object.fromEntries(Object.entries(crops).map(([id, crop]) => [id, {
        rawDataUrl: crop.rawDataUrl,
        processedDataUrl: crop.processedDataUrl
      }]))
    };
  }

  async close() {}
}

module.exports = { ValorantWindowCapture, captureSizeCheck, frameLuminance, frameRgb, otsuThreshold, preprocessNativeImage, redPixelRatio };
