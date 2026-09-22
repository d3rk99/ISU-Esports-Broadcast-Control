const { preprocessNativeImage, redPixelRatio } = require('./valorant-capture.cjs');

const NATIVE_BACKEND = 'windows-graphics-capture';
const FALLBACK_BACKEND = 'electron-desktop-capturer';

function captureError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function packedBgraBuffer(nativeFrame, width, height) {
  const source = Buffer.from(nativeFrame.buffer);
  const packedRowBytes = width * 4;
  const rowPitch = Number(nativeFrame.rowPitch) || packedRowBytes;
  if (rowPitch === packedRowBytes) return source.subarray(0, packedRowBytes * height);
  if (rowPitch < packedRowBytes || source.length < rowPitch * height) {
    throw captureError('Windows Graphics Capture returned an invalid bitmap stride', 'NATIVE_CAPTURE_BITMAP');
  }
  const packed = Buffer.allocUnsafe(packedRowBytes * height);
  for (let row = 0; row < height; row += 1) {
    source.copy(packed, row * packedRowBytes, row * rowPitch, row * rowPitch + packedRowBytes);
  }
  return packed;
}

class NativeValorantWindowCapture {
  constructor({ nativeImage, expectedWidth = 1920, expectedHeight = 1080, sizeTolerancePixels = 2, loadModule = () => import('@screen-capture/node'), now = () => Date.now() } = {}) {
    this.nativeImage = nativeImage;
    this.expectedWidth = expectedWidth;
    this.expectedHeight = expectedHeight;
    this.sizeTolerancePixels = Math.max(0, Number(sizeTolerancePixels) || 0);
    this.loadModule = loadModule;
    this.now = now;
    this.modulePromise = null;
    this.session = null;
    this.sessionPromise = null;
    this.sessionGeneration = 0;
    this.activeHandle = null;
    this.latestFrame = null;
    this.waiters = new Set();
    this.sessionError = null;
  }

  async getModule() {
    if (!this.modulePromise) {
      this.modulePromise = this.loadModule().then((captureModule) => {
        if (!captureModule?.isSupported?.() || !captureModule?.captureApiSupport?.().graphicsCapture) {
          throw captureError('Windows Graphics Capture is unavailable on this system', 'NATIVE_CAPTURE_UNAVAILABLE');
        }
        return captureModule;
      }).catch((error) => {
        this.modulePromise = null;
        if (error?.code) throw error;
        throw captureError(`Could not load Windows Graphics Capture: ${error?.message || error}`, 'NATIVE_CAPTURE_LOAD', { cause: error?.message });
      });
    }
    return this.modulePromise;
  }

  async listWindows() {
    const captureModule = await this.getModule();
    return captureModule.enumerateWindows()
      .filter((window) => window.isValid && window.title)
      .map((window) => ({ id: `hwnd:${window.handle}`, name: window.title, handle: window.handle, width: window.width, height: window.height, backend: NATIVE_BACKEND }));
  }

  selectWindow(windows, windowName) {
    const needle = String(windowName || 'VALORANT').trim().toLowerCase();
    return windows.find((candidate) => candidate.title.toLowerCase() === needle)
      || windows.find((candidate) => candidate.title.toLowerCase().includes(needle));
  }

  async ensureSession(windowName, captureFps = 8) {
    const captureModule = await this.getModule();
    const target = this.selectWindow(captureModule.enumerateWindows().filter((window) => window.isValid && window.title), windowName);
    if (!target) throw captureError(`Window containing “${windowName || 'VALORANT'}” was not found`, 'WINDOW_NOT_FOUND');
    if (this.session && this.activeHandle === target.handle && !this.sessionError) return;
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = this.startSession(captureModule, target, captureFps).finally(() => { this.sessionPromise = null; });
    return this.sessionPromise;
  }

  async startSession(captureModule, target, captureFps) {
    await this.stopSession();
    const options = {
      windowHandle: target.handle,
      cursorCapture: false,
      colorFormat: captureModule.ColorFormat?.Bgra8 || 'bgra8'
    };
    const support = captureModule.captureApiSupport();
    if (support.minimumUpdateInterval) options.minimumUpdateIntervalMs = Math.max(16, Math.round(1000 / Math.max(1, Number(captureFps) || 8)));
    const session = new captureModule.ScreenCapture(options);
    try {
      await session.start();
    } catch (error) {
      throw captureError(`Windows Graphics Capture could not start for “${target.title}”: ${error?.message || error}`, 'NATIVE_CAPTURE_START', { sourceName: target.title });
    }
    const generation = ++this.sessionGeneration;
    this.session = session;
    this.activeHandle = target.handle;
    this.activeWindow = target;
    this.latestFrame = null;
    this.sessionError = null;
    this.pumpFrames(session, target, generation);
  }

  async pumpFrames(session, target, generation) {
    try {
      while (this.session === session && generation === this.sessionGeneration) {
        const nativeFrame = await session.nextFrame();
        if (!nativeFrame) throw captureError(`Windows Graphics Capture closed for “${target.title}”`, 'NATIVE_CAPTURE_CLOSED');
        const frame = this.convertFrame(nativeFrame, target);
        this.latestFrame = frame;
        this.resolveWaiters(frame);
      }
    } catch (error) {
      if (generation !== this.sessionGeneration) return;
      this.sessionError = error?.code ? error : captureError(error?.message || 'Windows Graphics Capture failed', 'NATIVE_CAPTURE_FRAME');
      this.rejectWaiters(this.sessionError);
      if (this.session === session) this.session = null;
    }
  }

  convertFrame(nativeFrame, target) {
    const sourceWidth = Number(nativeFrame.width) || 0;
    const sourceHeight = Number(nativeFrame.height) || 0;
    if (!sourceWidth || !sourceHeight) throw captureError(`The selected “${target.title}” window returned an empty native frame`, 'CAPTURE_EMPTY');
    const widthDifference = Math.abs(sourceWidth - this.expectedWidth);
    const heightDifference = Math.abs(sourceHeight - this.expectedHeight);
    if (widthDifference > this.sizeTolerancePixels || heightDifference > this.sizeTolerancePixels) {
      throw captureError(`VALORANT capture is ${sourceWidth}×${sourceHeight}; use 1920×1080 or a source within ${this.sizeTolerancePixels} pixels`, 'CAPTURE_SIZE', {
        width: sourceWidth,
        height: sourceHeight,
        expectedWidth: this.expectedWidth,
        expectedHeight: this.expectedHeight,
        tolerance: this.sizeTolerancePixels
      });
    }
    let image = this.nativeImage.createFromBitmap(packedBgraBuffer(nativeFrame, sourceWidth, sourceHeight), { width: sourceWidth, height: sourceHeight });
    const normalized = widthDifference !== 0 || heightDifference !== 0;
    if (normalized) image = image.resize({ width: this.expectedWidth, height: this.expectedHeight, quality: 'best' });
    return {
      sourceId: `hwnd:${target.handle}`,
      sourceName: target.title,
      image,
      width: this.expectedWidth,
      height: this.expectedHeight,
      sourceWidth,
      sourceHeight,
      normalized,
      backend: NATIVE_BACKEND,
      capturedAt: this.now()
    };
  }

  async capture(windowName = 'VALORANT', options = {}) {
    await this.ensureSession(windowName, options.captureFps);
    if (this.sessionError) throw this.sessionError;
    if (this.latestFrame && this.now() - this.latestFrame.capturedAt < 1500) return this.latestFrame;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(captureError(`Windows Graphics Capture timed out waiting for “${this.activeWindow?.title || windowName}”`, 'NATIVE_CAPTURE_TIMEOUT'));
      }, 2000);
      this.waiters.add(waiter);
    });
  }

  resolveWaiters(frame) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
    this.waiters.clear();
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  crop(frame, roi, preprocess = {}) {
    const image = frame.image.crop({ x: roi.x, y: roi.y, width: roi.w, height: roi.h });
    const processed = preprocessNativeImage(this.nativeImage, image, preprocess);
    return { image: processed.toPNG(), rawDataUrl: image.toDataURL(), processedDataUrl: processed.toDataURL() };
  }

  redRatio(frame, roi) {
    return redPixelRatio(frame.image.crop({ x: roi.x, y: roi.y, width: roi.w, height: roi.h }));
  }

  snapshot(frame, fields) {
    const crops = {};
    for (const [id, field] of Object.entries(fields)) crops[id] = this.crop(frame, field.roi, field.preprocess);
    return {
      capturedAt: frame.capturedAt,
      sourceName: frame.sourceName,
      backend: frame.backend,
      width: frame.width,
      height: frame.height,
      sourceWidth: frame.sourceWidth || frame.width,
      sourceHeight: frame.sourceHeight || frame.height,
      normalized: Boolean(frame.normalized),
      frameDataUrl: frame.image.toDataURL(),
      crops: Object.fromEntries(Object.entries(crops).map(([id, crop]) => [id, { rawDataUrl: crop.rawDataUrl, processedDataUrl: crop.processedDataUrl }]))
    };
  }

  async stopSession() {
    const session = this.session;
    this.session = null;
    this.activeHandle = null;
    this.activeWindow = null;
    this.latestFrame = null;
    this.sessionError = null;
    this.sessionGeneration += 1;
    this.rejectWaiters(captureError('Capture session restarted', 'CAPTURE_RESTARTED'));
    try { await session?.stop?.(); } catch {}
  }

  async close() {
    await this.stopSession();
  }
}

class HybridValorantWindowCapture {
  constructor({ nativeCapture, fallbackCapture } = {}) {
    this.nativeCapture = nativeCapture;
    this.fallbackCapture = fallbackCapture;
    this.lastBackend = null;
    this.nativeFailure = null;
  }

  async listWindows() {
    try { return await this.nativeCapture.listWindows(); } catch {}
    return this.fallbackCapture.listWindows();
  }

  async capture(windowName, options = {}) {
    const backend = ['native', 'electron'].includes(options.backend) ? options.backend : 'auto';
    if (backend !== 'electron') {
      try {
        const frame = await this.nativeCapture.capture(windowName, options);
        this.lastBackend = NATIVE_BACKEND;
        this.nativeFailure = null;
        return frame;
      } catch (error) {
        this.nativeFailure = error;
        if (backend === 'native') throw error;
      }
    }
    const frame = await this.fallbackCapture.capture(windowName, options);
    this.lastBackend = FALLBACK_BACKEND;
    return { ...frame, backend: FALLBACK_BACKEND, fallbackReason: this.nativeFailure?.message || null };
  }

  crop(frame, roi, preprocess) {
    return (frame.backend === NATIVE_BACKEND ? this.nativeCapture : this.fallbackCapture).crop(frame, roi, preprocess);
  }

  redRatio(frame, roi) {
    return (frame.backend === NATIVE_BACKEND ? this.nativeCapture : this.fallbackCapture).redRatio(frame, roi);
  }

  snapshot(frame, fields) {
    return (frame.backend === NATIVE_BACKEND ? this.nativeCapture : this.fallbackCapture).snapshot(frame, fields);
  }

  async close() {
    await this.nativeCapture?.close?.();
    await this.fallbackCapture?.close?.();
  }
}

module.exports = { FALLBACK_BACKEND, HybridValorantWindowCapture, NATIVE_BACKEND, NativeValorantWindowCapture, packedBgraBuffer };
