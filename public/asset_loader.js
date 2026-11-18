(() => {
  'use strict';

  const IDB_NAME = 'gta3web_vfs_v1';
  const IDB_VERSION = 1;
  const IDB_STORE = 'packs';
  const ARCHIVE_MAGIC = 'GTA3PK01';
  const MANIFEST_URL = '/chunks/manifest.json';
  const DOWNLOAD_CONCURRENCY = 6;

  const utf8Decoder = new TextDecoder('utf-8');

  let cachedManifest = null;
  let manifestPromise = null;

  function openPackDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'sha256' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });
  }

  async function idbGetPack(sha256) {
    if (!sha256) return null;
    try {
      const db = await openPackDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(sha256);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
        tx.oncomplete = () => db.close();
      });
    } catch (_) {
      return null;
    }
  }

  async function idbPutPack(sha256, packName, arrayBuffer, fileCount) {
    if (!sha256 || !arrayBuffer) return false;
    try {
      const db = await openPackDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);

        // Evict stale versions of the same packName so storage doesn't bloat across updates
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const val = cursor.value;
            if (val && val.packName === packName && val.sha256 !== sha256) {
              cursor.delete();
            }
            cursor.continue();
            return;
          }
          store.put({
            sha256,
            packName,
            uncompressedSize: arrayBuffer.byteLength,
            fileCount,
            buffer: arrayBuffer,
            cachedAt: Date.now(),
          });
        };

        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          resolve(false);
        };
        tx.onabort = () => {
          db.close();
          resolve(false);
        };
      });
    } catch (_) {
      return false;
    }
  }

  async function idbDeletePack(sha256) {
    if (!sha256) return;
    try {
      const db = await openPackDb();
      await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(sha256);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      });
    } catch (_) {
      // Ignore IDB errors
    }
  }

  async function idbClearAll() {
    try {
      const db = await openPackDb();
      await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  async function verifySha256IfSupported(uint8Bytes, expectedHex) {
    if (!expectedHex) return true;
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
      console.warn('[GtaAssetLoader] crypto.subtle unavailable; skipping SHA-256 verification.');
      return true;
    }
    const digestBuf = await subtle.digest('SHA-256', uint8Bytes);
    const actualHex = bytesToHex(new Uint8Array(digestBuf));
    if (actualHex.toLowerCase() !== expectedHex.toLowerCase()) {
      throw new Error(`SHA-256 mismatch: expected ${expectedHex}, got ${actualHex}`);
    }
    return true;
  }

  async function decompressGzip(compressedBytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Browser does not support DecompressionStream("gzip")');
    }
    const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  }

  async function downloadChunksParallel(chunks, expectedTotalBytes, packName, onProgress) {
    const totalBytes = expectedTotalBytes || 0;
    const perChunkLoaded = new Array(chunks.length).fill(0);
    const chunkParts = new Array(chunks.length);
    const chunkSizes = new Array(chunks.length).fill(0);
    let lastEmitTs = 0;

    function emitDownloadProgress(force) {
      if (typeof onProgress !== 'function') return;
      const now = performance.now();
      if (!force && now - lastEmitTs < 50) return;
      lastEmitTs = now;
      let loadedBytes = 0;
      for (let i = 0; i < perChunkLoaded.length; i++) {
        loadedBytes += perChunkLoaded[i];
      }
      onProgress({
        loadedBytes,
        totalBytes: Math.max(totalBytes, loadedBytes),
        phase: 'download',
        cacheHit: false,
        pack: packName,
      });
    }

    let nextIndex = 0;
    async function worker() {
      while (nextIndex < chunks.length) {
        const idx = nextIndex++;
        const url = chunks[idx];
        const res = await fetch(url, { cache: 'default' });
        if (!res.ok) {
          throw new Error(`Failed to fetch asset chunk ${url} (HTTP ${res.status})`);
        }
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const pieces = [];
          let byteCount = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              pieces.push(value);
              byteCount += value.byteLength;
              perChunkLoaded[idx] = byteCount;
              emitDownloadProgress(false);
            }
          }
          chunkParts[idx] = pieces;
          chunkSizes[idx] = byteCount;
        } else {
          const buf = await res.arrayBuffer();
          const u8 = new Uint8Array(buf);
          chunkParts[idx] = [u8];
          chunkSizes[idx] = u8.byteLength;
          perChunkLoaded[idx] = u8.byteLength;
          emitDownloadProgress(true);
        }
      }
    }

    const workerCount = Math.min(DOWNLOAD_CONCURRENCY, Math.max(1, chunks.length));
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    emitDownloadProgress(true);

    let actualTotal = 0;
    for (let i = 0; i < chunkSizes.length; i++) {
      actualTotal += chunkSizes[i];
    }
    const merged = new Uint8Array(actualTotal);
    let writeOffset = 0;
    for (let i = 0; i < chunkParts.length; i++) {
      const pieces = chunkParts[i];
      for (let j = 0; j < pieces.length; j++) {
        merged.set(pieces[j], writeOffset);
        writeOffset += pieces[j].byteLength;
      }
      chunkParts[i] = null;
    }
    return merged;
  }

  function validateArchiveHeader(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 12) {
      throw new Error('GTA3PK01 buffer too small');
    }
    const bytes = new Uint8Array(arrayBuffer);
    const magic = utf8Decoder.decode(bytes.subarray(0, 8));
    if (magic !== ARCHIVE_MAGIC) {
      throw new Error(`Invalid GTA3PK01 magic header: "${magic}"`);
    }
    const view = new DataView(arrayBuffer);
    const fileCount = view.getUint32(8, true);
    return { bytes, view, fileCount };
  }

  async function mountArchiveToFS(FS, arrayBuffer, packName, cacheHit, onProgress) {
    if (!FS || typeof FS.writeFile !== 'function' || typeof FS.mkdirTree !== 'function') {
      throw new Error('Emscripten FS instance is not ready');
    }

    const { bytes, view, fileCount } = validateArchiveHeader(arrayBuffer);
    const totalBytes = arrayBuffer.byteLength;

    try {
      FS.chdir('/');
    } catch (_) {
      // Ignore if already at root
    }
    try {
      FS.mkdirTree('/userfiles');
      FS.mkdirTree('/MP3');
    } catch (_) {
      // Ignore if directories already exist
    }

    const createdDirs = new Set(['/']);
    let offset = 12;
    let lastYieldTs = performance.now();

    for (let i = 0; i < fileCount; i++) {
      if (offset + 2 > totalBytes) {
        throw new Error(`Corrupt GTA3PK01 pack (${packName}): truncated path length at entry ${i}`);
      }
      const pathLen = view.getUint16(offset, true);
      offset += 2;

      if (offset + pathLen + 4 > totalBytes) {
        throw new Error(`Corrupt GTA3PK01 pack (${packName}): truncated path/size at entry ${i}`);
      }
      const rawPath = utf8Decoder.decode(bytes.subarray(offset, offset + pathLen));
      offset += pathLen;

      const fileLen = view.getUint32(offset, true);
      offset += 4;

      if (offset + fileLen > totalBytes) {
        throw new Error(`Corrupt GTA3PK01 pack (${packName}): truncated data for ${rawPath}`);
      }
      const fileSlice = bytes.subarray(offset, offset + fileLen);
      offset += fileLen;

      const cleanRel = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!cleanRel) continue;
      const fullPath = '/' + cleanRel;
      const slashIdx = fullPath.lastIndexOf('/');
      if (slashIdx > 0) {
        const parentDir = fullPath.slice(0, slashIdx);
        if (!createdDirs.has(parentDir)) {
          FS.mkdirTree(parentDir);
          createdDirs.add(parentDir);
        }
      }

      FS.writeFile(fullPath, fileSlice, { canOwn: true });

      const now = performance.now();
      if (now - lastYieldTs > 50 || i === fileCount - 1) {
        if (typeof onProgress === 'function') {
          onProgress({
            loadedBytes: offset,
            totalBytes,
            phase: 'unpack',
            cacheHit,
            pack: packName,
            fileIndex: i + 1,
            fileCount,
            currentFile: cleanRel,
          });
        }
        if (i < fileCount - 1) {
          await new Promise((r) => setTimeout(r, 0));
        }
        lastYieldTs = performance.now();
      }
    }

    try {
      FS.chdir('/');
    } catch (_) {
      // Ignore
    }

    if (typeof onProgress === 'function') {
      onProgress({
        loadedBytes: totalBytes,
        totalBytes,
        phase: 'ready',
        cacheHit,
        pack: packName,
        fileIndex: fileCount,
        fileCount,
      });
    }

    return { fileCount, uncompressedSize: totalBytes, cacheHit };
  }

  async function fetchManifest(forceRefresh = false) {
    if (cachedManifest && !forceRefresh) return cachedManifest;
    if (manifestPromise && !forceRefresh) return manifestPromise;

    manifestPromise = (async () => {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) {
        throw new Error(`Failed to fetch ${MANIFEST_URL} (HTTP ${res.status})`);
      }
      const json = await res.json();
      if (!json || json.format !== ARCHIVE_MAGIC || !json.core) {
        throw new Error('Invalid manifest.json schema');
      }
      cachedManifest = json;
      return json;
    })();

    try {
      return await manifestPromise;
    } finally {
      manifestPromise = null;
    }
  }

  async function acquirePackBuffer(packName, packMeta, onProgress) {
    if (!packMeta || !Array.isArray(packMeta.chunks) || packMeta.chunks.length === 0) {
      throw new Error(`Missing chunks metadata for pack "${packName}"`);
    }

    const totalCompressed = packMeta.compressedSize || 0;
    const expectedUncompressed = packMeta.uncompressedSize || 0;

    if (typeof onProgress === 'function') {
      onProgress({
        loadedBytes: 0,
        totalBytes: totalCompressed || expectedUncompressed,
        phase: 'cache-check',
        cacheHit: false,
        pack: packName,
      });
    }

    const cached = await idbGetPack(packMeta.sha256);
    if (cached && cached.buffer instanceof ArrayBuffer) {
      try {
        validateArchiveHeader(cached.buffer);
        if (!expectedUncompressed || cached.buffer.byteLength === expectedUncompressed) {
          if (typeof onProgress === 'function') {
            onProgress({
              loadedBytes: cached.buffer.byteLength,
              totalBytes: cached.buffer.byteLength,
              phase: 'cache-hit',
              cacheHit: true,
              pack: packName,
            });
          }
          return { buffer: cached.buffer, cacheHit: true };
        }
      } catch (err) {
        console.warn(`[GtaAssetLoader] Discarding corrupt IndexedDB cache for ${packName}:`, err);
        await idbDeletePack(packMeta.sha256);
      }
    }

    const compressedBytes = await downloadChunksParallel(
      packMeta.chunks,
      totalCompressed,
      packName,
      onProgress
    );

    if (typeof onProgress === 'function') {
      onProgress({
        loadedBytes: compressedBytes.byteLength,
        totalBytes: compressedBytes.byteLength,
        phase: 'verify',
        cacheHit: false,
        pack: packName,
      });
    }
    await verifySha256IfSupported(compressedBytes, packMeta.sha256);

    if (typeof onProgress === 'function') {
      onProgress({
        loadedBytes: compressedBytes.byteLength,
        totalBytes: compressedBytes.byteLength,
        phase: 'decompress',
        cacheHit: false,
        pack: packName,
      });
    }
    const decompressedBuf = await decompressGzip(compressedBytes);
    if (expectedUncompressed && decompressedBuf.byteLength !== expectedUncompressed) {
      throw new Error(
        `Decompressed size mismatch for ${packName}: expected ${expectedUncompressed}, got ${decompressedBuf.byteLength}`
      );
    }
    validateArchiveHeader(decompressedBuf);

    // Best-effort IDB write in background (never blocks or fails boot if quota is limited)
    idbPutPack(packMeta.sha256, packName, decompressedBuf, packMeta.fileCount || 0).catch((err) => {
      console.warn('[GtaAssetLoader] IndexedDB write failed:', err);
    });

    return { buffer: decompressedBuf, cacheHit: false };
  }

  const loadedPacks = new Set();
  const inFlightPacks = new Map();

  const GtaAssetLoader = {
    async getManifest(forceRefresh = false) {
      return await fetchManifest(forceRefresh);
    },

    getCachedManifestSync() {
      return cachedManifest;
    },

    async isPackCached(packName = 'core') {
      try {
        const manifest = await fetchManifest(false);
        const meta = manifest[packName];
        if (!meta || !meta.sha256) return false;
        const entry = await idbGetPack(meta.sha256);
        return Boolean(entry && entry.buffer instanceof ArrayBuffer);
      } catch (_) {
        return false;
      }
    },

    async preparePack(packName = 'core', onProgress = null) {
      if (inFlightPacks.has(packName)) {
        return await inFlightPacks.get(packName);
      }
      const p = (async () => {
        if (typeof onProgress === 'function') {
          onProgress({
            loadedBytes: 0,
            totalBytes: 0,
            phase: 'manifest',
            cacheHit: false,
            pack: packName,
          });
        }
        const manifest = await fetchManifest(false);
        const meta = manifest[packName];
        if (!meta) {
          return null;
        }
        const res = await acquirePackBuffer(packName, meta, onProgress);
        return { manifest, meta, ...res };
      })();
      inFlightPacks.set(packName, p);
      try {
        return await p;
      } finally {
        inFlightPacks.delete(packName);
      }
    },

    async mountPreparedPackToFS(FS, prepared, packName = 'core', onProgress = null) {
      if (!prepared || !prepared.buffer) {
        throw new Error(`No prepared buffer for pack "${packName}"`);
      }
      const res = await mountArchiveToFS(FS, prepared.buffer, packName, prepared.cacheHit, onProgress);
      loadedPacks.add(packName);
      return res;
    },

    async loadPack(FS, packName = 'core', onProgress = null) {
      const prepared = await this.preparePack(packName, onProgress);
      if (!prepared) return null;
      return await this.mountPreparedPackToFS(FS, prepared, packName, onProgress);
    },

    async loadCore(FS, onProgress = null) {
      return await this.loadPack(FS, 'core', onProgress);
    },

    async loadCuts(FS, onProgress = null) {
      return await this.loadPack(FS, 'cuts', onProgress);
    },

    isPackMounted(packName) {
      return loadedPacks.has(packName);
    },

    async clearCache() {
      return await idbClearAll();
    },
  };

  // ============================================================================
  // GtaAudioStream — Lazy Radio & Mission Audio Streamer (slots 0..1)
  // ============================================================================
  let audioCtx = null;
  let audioUnlocked = false;
  let unlockListenersAttached = false;
  const streamSlots = new Map();

  function normalizeAudioKey(filename) {
    let clean = String(filename || '')
      .replace(/\\/g, '/')
      .trim()
      .toLowerCase();
    clean = clean.replace(/^(\.\/|\/)+/, '');
    if (clean.startsWith('audio/')) {
      clean = clean.slice('audio/'.length);
    }
    return clean;
  }

  function resolveAudioUrl(filename) {
    const norm = normalizeAudioKey(filename);
    if (!norm) return null;
    const base = norm.split('/').pop();
    const streams = cachedManifest && cachedManifest.audioStreams;
    if (streams) {
      if (streams[norm] && streams[norm].url) return streams[norm].url;
      if (streams[base] && streams[base].url) return streams[base].url;
    }
    const stem = base.replace(/\.[^.]+$/, '');
    return `/audio/${stem}.mp3`;
  }

  function ensureAudioContext() {
    if (audioCtx) return audioCtx;
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audioCtx = new Ctx();
    } catch (_) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function wireWebAudioNodes(slot) {
    if (slot.wired || !audioCtx) return;
    try {
      const src = audioCtx.createMediaElementSource(slot.audio);
      const gain = audioCtx.createGain();
      const panner =
        typeof audioCtx.createStereoPanner === 'function' ? audioCtx.createStereoPanner() : null;

      if (panner) {
        src.connect(panner);
        panner.connect(gain);
      } else {
        src.connect(gain);
      }
      gain.connect(audioCtx.destination);

      slot.sourceNode = src;
      slot.gainNode = gain;
      slot.pannerNode = panner;
      slot.wired = true;

      // Avoid double attenuation between HTMLAudioElement.volume and GainNode
      slot.audio.volume = 1.0;
      applySlotGainAndPan(slot);
    } catch (err) {
      // Fallback safely to HTMLAudioElement.volume if MediaElementSource fails
      console.warn('[GtaAudioStream] WebAudio node wiring fallback:', err);
    }
  }

  function applySlotGainAndPan(slot) {
    const vol = Math.max(0, Math.min(1, slot.vol0to127 / 127));
    let pan = 0;
    if (Math.abs(slot.pan0to127 - 64) > 1) {
      pan = Math.max(-1, Math.min(1, (slot.pan0to127 - 63.5) / 63.5));
    }

    if (slot.wired && slot.gainNode) {
      slot.gainNode.gain.value = vol;
      if (slot.pannerNode) {
        slot.pannerNode.pan.value = pan;
      }
    } else {
      slot.audio.volume = vol;
    }
  }

  function attemptPlay(slot) {
    if (slot.stopped || slot.paused || !slot.url) return;
    if (audioCtx && audioCtx.state === 'suspended' && audioUnlocked) {
      audioCtx.resume().catch(() => {});
    }
    try {
      const playPromise = slot.audio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            slot.pendingPlay = false;
          })
          .catch(() => {
            // Autoplay blocked until first user gesture
            if (!slot.stopped && !slot.paused) {
              slot.pendingPlay = true;
            }
          });
      }
    } catch (_) {
      if (!slot.stopped && !slot.paused) {
        slot.pendingPlay = true;
      }
    }
  }

  function onFirstUserGesture() {
    audioUnlocked = true;
    const ctx = ensureAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    for (const slot of streamSlots.values()) {
      wireWebAudioNodes(slot);
      if (slot.pendingPlay && !slot.stopped && !slot.paused && !slot.ended) {
        attemptPlay(slot);
      }
    }
  }

  function attachGestureUnlock() {
    if (unlockListenersAttached || typeof window === 'undefined') return;
    unlockListenersAttached = true;
    const events = ['pointerdown', 'keydown', 'mousedown', 'touchstart', 'click'];
    const handler = () => {
      onFirstUserGesture();
      if (audioCtx && audioCtx.state === 'running') {
        for (const ev of events) {
          window.removeEventListener(ev, handler, true);
        }
      }
    };
    for (const ev of events) {
      window.addEventListener(ev, handler, { capture: true, passive: true });
    }
  }

  function getOrCreateSlot(streamIdx) {
    const idx = Number(streamIdx) | 0;
    let slot = streamSlots.get(idx);
    if (slot) return slot;

    const audio = new Audio();
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';

    slot = {
      idx,
      audio,
      url: null,
      filename: '',
      preloadedUrl: null,
      preloadedFilename: '',
      stopped: true,
      paused: false,
      ended: false,
      pendingPlay: false,
      pendingSeekSec: null,
      vol0to127: 127,
      pan0to127: 64,
      wired: false,
      sourceNode: null,
      gainNode: null,
      pannerNode: null,
    };

    audio.addEventListener('loadedmetadata', () => {
      if (slot.pendingSeekSec !== null) {
        const dur = Number.isFinite(audio.duration) ? audio.duration : slot.pendingSeekSec;
        const target = Math.max(0, Math.min(slot.pendingSeekSec, Math.max(0, dur - 0.05)));
        try {
          audio.currentTime = target;
        } catch (_) {
          // Ignore seek errors on unready streams
        }
        slot.pendingSeekSec = null;
      }
    });

    audio.addEventListener('ended', () => {
      slot.ended = true;
      slot.pendingPlay = false;
    });

    audio.addEventListener('error', () => {
      slot.ended = true;
      slot.pendingPlay = false;
      console.warn(`[GtaAudioStream] Audio error on stream ${idx}: ${slot.url}`);
    });

    if (audioUnlocked) {
      ensureAudioContext();
      wireWebAudioNodes(slot);
    }

    streamSlots.set(idx, slot);
    return slot;
  }

  attachGestureUnlock();

  const GtaAudioStream = {
    unlock() {
      onFirstUserGesture();
    },

    preload(streamIdx, filename) {
      const slot = getOrCreateSlot(streamIdx);
      const url = resolveAudioUrl(filename);
      if (!url) return false;

      if (!cachedManifest) {
        fetchManifest(false).catch(() => {});
      }

      slot.preloadedUrl = url;
      slot.preloadedFilename = String(filename || '');
      slot.stopped = true;
      slot.paused = false;
      slot.ended = false;
      slot.pendingPlay = false;
      slot.pendingSeekSec = null;

      try {
        slot.audio.pause();
      } catch (_) {}

      if (slot.url !== url) {
        slot.url = url;
        slot.filename = slot.preloadedFilename;
        slot.audio.src = url;
        try {
          slot.audio.load();
        } catch (_) {}
      } else if (slot.audio.readyState >= 1) {
        try {
          slot.audio.currentTime = 0;
        } catch (_) {}
      }
      return true;
    },

    startPreloaded(streamIdx) {
      const slot = getOrCreateSlot(streamIdx);
      const url = slot.preloadedUrl || slot.url;
      if (!url) return false;

      if (slot.url !== url) {
        slot.url = url;
        slot.filename = slot.preloadedFilename || '';
        slot.audio.src = url;
      }
      slot.stopped = false;
      slot.paused = false;
      slot.ended = false;
      slot.pendingSeekSec = null;

      if (slot.audio.readyState >= 1 && slot.audio.currentTime > 0.05) {
        try {
          slot.audio.currentTime = 0;
        } catch (_) {}
      }
      applySlotGainAndPan(slot);
      attemptPlay(slot);
      return true;
    },

    start(streamIdx, filename, posMs = 0) {
      const slot = getOrCreateSlot(streamIdx);
      const url = resolveAudioUrl(filename);
      if (!url) return false;

      if (!cachedManifest) {
        fetchManifest(false).catch(() => {});
      }

      const seekSec = Math.max(0, Number(posMs) || 0) / 1000;
      slot.stopped = false;
      slot.paused = false;
      slot.ended = false;
      slot.pendingPlay = false;

      if (slot.url !== url) {
        slot.url = url;
        slot.filename = String(filename || '');
        slot.pendingSeekSec = seekSec > 0 ? seekSec : null;
        slot.audio.src = url;
        try {
          slot.audio.load();
        } catch (_) {}
      } else {
        if (slot.audio.readyState >= 1) {
          slot.pendingSeekSec = null;
          try {
            slot.audio.currentTime = seekSec;
          } catch (_) {
            slot.pendingSeekSec = seekSec > 0 ? seekSec : null;
          }
        } else {
          slot.pendingSeekSec = seekSec > 0 ? seekSec : null;
        }
      }

      applySlotGainAndPan(slot);
      attemptPlay(slot);
      return true;
    },

    stop(streamIdx) {
      const slot = getOrCreateSlot(streamIdx);
      slot.stopped = true;
      slot.paused = false;
      slot.ended = false;
      slot.pendingPlay = false;
      slot.pendingSeekSec = null;
      try {
        slot.audio.pause();
        if (slot.audio.readyState >= 1) {
          slot.audio.currentTime = 0;
        }
      } catch (_) {}
    },

    pause(streamIdx, paused) {
      const slot = getOrCreateSlot(streamIdx);
      const shouldPause = Boolean(paused);
      slot.paused = shouldPause;
      if (shouldPause) {
        slot.pendingPlay = false;
        try {
          slot.audio.pause();
        } catch (_) {}
      } else if (!slot.stopped && !slot.ended && slot.url) {
        attemptPlay(slot);
      }
    },

    setVolumeAndPan(streamIdx, vol0to127, pan0to127 = 64) {
      const slot = getOrCreateSlot(streamIdx);
      const v = Number(vol0to127);
      const p = Number(pan0to127);
      slot.vol0to127 = Number.isFinite(v) ? Math.max(0, Math.min(127, v)) : 127;
      slot.pan0to127 = Number.isFinite(p) ? Math.max(0, Math.min(127, p)) : 64;
      applySlotGainAndPan(slot);
    },

    getPositionMs(streamIdx) {
      const slot = streamSlots.get(Number(streamIdx) | 0);
      if (!slot || slot.stopped || !slot.url) return 0;
      if (slot.pendingSeekSec !== null && slot.audio.readyState < 1) {
        return (slot.pendingSeekSec * 1000) | 0;
      }
      const t = slot.audio.currentTime;
      return Number.isFinite(t) ? (t * 1000) | 0 : 0;
    },

    isPlaying(streamIdx) {
      const slot = streamSlots.get(Number(streamIdx) | 0);
      if (!slot || !slot.url) return false;
      return !slot.audio.ended && !slot.ended && !slot.paused && !slot.stopped;
    },

    getDebugState() {
      const out = {};
      for (const [idx, slot] of streamSlots.entries()) {
        out[idx] = {
          filename: slot.filename,
          url: slot.url,
          playing: this.isPlaying(idx),
          positionMs: this.getPositionMs(idx),
          vol: slot.vol0to127,
          pan: slot.pan0to127,
          webAudio: slot.wired,
        };
      }
      return out;
    },
  };

  if (typeof window !== 'undefined') {
    window.GtaAssetLoader = GtaAssetLoader;
    window.GtaAudioStream = GtaAudioStream;
  }
})();
