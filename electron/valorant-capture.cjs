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
  return nativeImageApi.createFromBitmap(bitmap, outputSize);
}

class ValorantWindowCapture {
  constructor({ desktopCapturer, nativeImage, expectedWidth = 1920, expectedHeight = 1080 } = {}) {
    this.desktopCapturer = desktopCapturer;
    this.nativeImage = nativeImage;
    this.expectedWidth = expectedWidth;
    this.expectedHeight = expectedHeight;
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
    if (size.width !== this.expectedWidth || size.height !== this.expectedHeight) {
      const error = new Error(`VALORANT capture is ${size.width}×${size.height}; set the game to 1920×1080`);
      error.code = 'CAPTURE_SIZE';
      error.details = { width: size.width, height: size.height };
      throw error;
    }
    return { sourceId: source.id, sourceName: source.name, image: source.thumbnail, width: size.width, height: size.height, capturedAt: Date.now() };
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

  snapshot(frame, fields) {
    const crops = {};
    for (const [id, field] of Object.entries(fields)) crops[id] = this.crop(frame, field.roi, field.preprocess);
    return {
      capturedAt: frame.capturedAt,
      sourceName: frame.sourceName,
      width: frame.width,
      height: frame.height,
      frameDataUrl: frame.image.toDataURL(),
      crops: Object.fromEntries(Object.entries(crops).map(([id, crop]) => [id, {
        rawDataUrl: crop.rawDataUrl,
        processedDataUrl: crop.processedDataUrl
      }]))
    };
  }
}

module.exports = { ValorantWindowCapture, otsuThreshold, preprocessNativeImage };
