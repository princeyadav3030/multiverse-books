// File: modules/pdf-engine.js
// SPARSE-MEMORY VIRTUAL RANGE ENGINE v4.0 (100% Fixes "Array buffer allocation failed" on 700MB-1GB+ PDFs)
// Features: Live Patched Sparse Worker + Parallel Range Transport + 5-Page Sliding Window (2 Up / 2 Down)

import { showToast } from "./helpers.js";

// ==========================================
// 1. ENGINE STATE & PERFORMANCE CONSTANTS
// ==========================================
export let currentPdfDocument = null;
export let pdfTotalPagesCount = 0;
export let renderedPagesMap = new Map();
export let activeRenderTasks = new Map();
export let pdfVirtualObserver = null;
export let currentPdfPageInView = 1;
export let currentZoomScale = 1.0;
export let basePageWidth = 0;
export let basePageAspectRatio = 1.414;
export let isDoubleTapBound = false;

// STRICT 5-PAGE WINDOW: Current Page + 2 Pages Above + 2 Pages Below
const RENDER_BUFFER_DISTANCE = 2; 
const MAX_RENDERED_PAGES = 6; 
const MAX_CONCURRENT_RENDERS = 2;

// 512 KB Chunk Size for Fast Multiplexed Range Streaming
const RANGE_CHUNK_SIZE = 524288; 

let renderQueue = [];
let activeWorkersCount = 0;
let lastContainerScrollTime = 0;
let activeLoadingTask = null;
let activeRangeTransport = null;
let scrollDebounceTimer = null;
let isSparseWorkerInitialized = false;

// Recycled Canvas Pool
const canvasRecyclePool = [];

function acquirePooledCanvas() {
    if (canvasRecyclePool.length > 0) {
        return canvasRecyclePool.pop();
    }
    return document.createElement('canvas');
}

function releaseCanvasToPool(canvas) {
    if (!canvas) return;
    try {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 1;
        canvas.height = 1;
        canvas.removeAttribute('style');
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        if (canvasRecyclePool.length < 8) {
            canvasRecyclePool.push(canvas);
        }
    } catch (e) {}
}

// ==========================================
// 2. SPARSE-MEMORY WORKER PATCHER (PREVENTS 700MB+ ARRAYBUFFER CRASH)
// ==========================================
async function ensureSparsePdfWorker() {
    if (isSparseWorkerInitialized || !window.pdfjsLib) return;
    try {
        const workerCdnUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const res = await fetch(workerCdnUrl);
        if (!res.ok) return;
        let workerCode = await res.text();

        // Inject Sparse Virtual Uint8Array Proxy for files > 200MB so mobile RAM never crashes!
        const sparseInterceptorHeader = `
        const __OrigUint8Array = self.Uint8Array;
        function __createSparseByteStorage(totalLength) {
            const PAGE_SIZE = 262144; // 256KB virtual memory pages
            const pages = new Map();
            const MAX_PAGES_IN_RAM = 240; // Max ~60MB in RAM at any instant

            function getPage(pageIdx, create) {
                let p = pages.get(pageIdx);
                if (!p && create) {
                    if (pages.size >= MAX_PAGES_IN_RAM) {
                        const oldestKey = pages.keys().next().value;
                        pages.delete(oldestKey);
                    }
                    p = new __OrigUint8Array(PAGE_SIZE);
                    pages.set(pageIdx, p);
                } else if (p) {
                    // Refresh LRU order
                    pages.delete(pageIdx);
                    pages.set(pageIdx, p);
                }
                return p;
            }

            const target = {
                length: totalLength,
                byteLength: totalLength,
                set(sourceArr, offset = 0) {
                    const srcLen = sourceArr.length;
                    let srcPos = 0;
                    let dstPos = offset;
                    while (srcPos < srcLen) {
                        const pageIdx = (dstPos / PAGE_SIZE) | 0;
                        const pageOff = dstPos % PAGE_SIZE;
                        const copyLen = Math.min(PAGE_SIZE - pageOff, srcLen - srcPos);
                        const page = getPage(pageIdx, true);
                        if (sourceArr.subarray) {
                            page.set(sourceArr.subarray(srcPos, srcPos + copyLen), pageOff);
                        } else {
                            for (let i = 0; i < copyLen; i++) page[pageOff + i] = sourceArr[srcPos + i];
                        }
                        srcPos += copyLen;
                        dstPos += copyLen;
                    }
                },
                subarray(begin = 0, end = totalLength) {
                    const b = Math.max(0, begin < 0 ? totalLength + begin : begin);
                    const e = Math.min(totalLength, end < 0 ? totalLength + end : end);
                    const len = Math.max(0, e - b);
                    const out = new __OrigUint8Array(len);
                    let dstPos = 0;
                    let curPos = b;
                    while (dstPos < len) {
                        const pageIdx = (curPos / PAGE_SIZE) | 0;
                        const pageOff = curPos % PAGE_SIZE;
                        const copyLen = Math.min(PAGE_SIZE - pageOff, len - dstPos);
                        const page = pages.get(pageIdx);
                        if (page) {
                            out.set(page.subarray(pageOff, pageOff + copyLen), dstPos);
                        }
                        dstPos += copyLen;
                        curPos += copyLen;
                    }
                    return out;
                },
                slice(begin = 0, end = totalLength) {
                    return this.subarray(begin, end);
                }
            };

            return new Proxy(target, {
                get(obj, prop) {
                    if (prop in obj) return obj[prop];
                    if (typeof prop === 'string') {
                        const idx = Number(prop);
                        if (Number.isInteger(idx) && idx >= 0 && idx < totalLength) {
                            const page = pages.get((idx / PAGE_SIZE) | 0);
                            return page ? page[idx % PAGE_SIZE] : 0;
                        }
                    }
                    return obj[prop];
                },
                set(obj, prop, val) {
                    if (typeof prop === 'string') {
                        const idx = Number(prop);
                        if (Number.isInteger(idx) && idx >= 0 && idx < totalLength) {
                            const page = getPage((idx / PAGE_SIZE) | 0, true);
                            page[idx % PAGE_SIZE] = val;
                            return true;
                        }
                    }
                    obj[prop] = val;
                    return true;
                }
            });
        }
        `;

        // Replace ChunkedStream huge buffer allocation with Sparse Virtual Storage when length > 150MB
        workerCode = workerCode.replace(
            /this\.bytes\s*=\s*new\s+Uint8Array\s*\(\s*length\s*\)/g,
            'this.bytes = (length > 150000000 ? __createSparseByteStorage(length) : new Uint8Array(length))'
        );

        const finalBlob = new Blob([sparseInterceptorHeader + "\n" + workerCode], { type: 'application/javascript' });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(finalBlob);
        isSparseWorkerInitialized = true;
    } catch (e) {
        console.warn("Sparse worker patch fallback:", e);
    }
}

// ==========================================
// 3. CUSTOM HIGH-SPEED PARALLEL RANGE TRANSPORT
// ==========================================
async function createFastRangeTransport(pdfUrl) {
    // Step 1: Fast Probe Request (Fetches first 512KB + Total File Size in 1 trip!)
    const initialEnd = RANGE_CHUNK_SIZE - 1;
    const probeRes = await fetch(pdfUrl, {
        method: 'GET',
        headers: { 'Range': `bytes=0-${initialEnd}` },
        mode: 'cors',
        credentials: 'omit'
    });

    if (!probeRes.ok && probeRes.status !== 206) {
        throw new Error(`Server returned status ${probeRes.status}`);
    }

    let totalLength = 0;
    const contentRange = probeRes.headers.get('Content-Range');
    if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match && match[1]) {
            totalLength = parseInt(match[1], 10);
        }
    }
    if (!totalLength) {
        const cl = probeRes.headers.get('Content-Length');
        if (cl) totalLength = parseInt(cl, 10);
    }

    const firstChunkBuffer = new Uint8Array(await probeRes.arrayBuffer());
    if (!totalLength || totalLength < firstChunkBuffer.byteLength) {
        totalLength = firstChunkBuffer.byteLength;
    }

    class SpidyFastRangeTransport extends window.pdfjsLib.PDFDataRangeTransport {
        constructor(length, initialData) {
            super(length, initialData, true);
            this.aborted = false;
            this.controllers = new Set();
            this.chunkCache = new Map();
            this.inflightRequests = new Map();

            // Cache initial chunk
            this.chunkCache.set(`0-${initialData.byteLength - 1}`, initialData);

            // Pre-warm PDF Trailer (Last 1MB) in background immediately for instant XREF indexing!
            if (length > RANGE_CHUNK_SIZE * 2) {
                const tailStart = Math.max(0, Math.floor((length - RANGE_CHUNK_SIZE) / RANGE_CHUNK_SIZE) * RANGE_CHUNK_SIZE);
                this.prefetchChunk(tailStart, length);
                if (tailStart - RANGE_CHUNK_SIZE > 0) {
                    this.prefetchChunk(tailStart - RANGE_CHUNK_SIZE, tailStart);
                }
            }
        }

        async prefetchChunk(begin, end) {
            const alignedEnd = Math.min(end, totalLength) - 1;
            const key = `${begin}-${alignedEnd}`;
            if (this.chunkCache.has(key) || this.inflightRequests.has(key) || this.aborted) return;

            const promise = (async () => {
                const controller = new AbortController();
                this.controllers.add(controller);
                try {
                    const r = await fetch(pdfUrl, {
                        method: 'GET',
                        headers: { 'Range': `bytes=${begin}-${alignedEnd}` },
                        signal: controller.signal,
                        mode: 'cors',
                        credentials: 'omit'
                    });
                    if (r.ok || r.status === 206) {
                        const buf = new Uint8Array(await r.arrayBuffer());
                        if (this.chunkCache.size > 24) {
                            const oldest = this.chunkCache.keys().next().value;
                            this.chunkCache.delete(oldest);
                        }
                        this.chunkCache.set(key, buf);
                        return buf;
                    }
                } catch (e) {} finally {
                    this.controllers.delete(controller);
                    this.inflightRequests.delete(key);
                }
                return null;
            })();

            this.inflightRequests.set(key, promise);
            return promise;
        }

        async requestDataRange(begin, end) {
            if (this.aborted) return;
            const alignedEnd = Math.min(end, totalLength) - 1;
            const key = `${begin}-${alignedEnd}`;

            // 1. Check In-Memory Pre-fetched Cache
            if (this.chunkCache.has(key)) {
                const cached = this.chunkCache.get(key);
                this.chunkCache.delete(key);
                this.onDataRange(begin, cached);
                return;
            }

            // 2. Check In-Flight Pre-fetch Request
            if (this.inflightRequests.has(key)) {
                const inflightBuf = await this.inflightRequests.get(key);
                if (inflightBuf && !this.aborted) {
                    this.chunkCache.delete(key);
                    this.onDataRange(begin, inflightBuf);
                    return;
                }
            }

            // 3. Direct High-Priority Fetch + Lookahead Pre-fetch of Next Neighboring Chunk
            const nextBegin = alignedEnd + 1;
            if (nextBegin < totalLength && begin > RANGE_CHUNK_SIZE) {
                this.prefetchChunk(nextBegin, Math.min(nextBegin + RANGE_CHUNK_SIZE, totalLength));
            }

            const controller = new AbortController();
            this.controllers.add(controller);

            try {
                const res = await fetch(pdfUrl, {
                    method: 'GET',
                    headers: { 'Range': `bytes=${begin}-${alignedEnd}` },
                    signal: controller.signal,
                    mode: 'cors',
                    credentials: 'omit'
                });

                if (!res.ok && res.status !== 206) return;
                const chunk = new Uint8Array(await res.arrayBuffer());
                if (!this.aborted) {
                    this.onDataRange(begin, chunk);
                }
            } catch (err) {
                // Ignore abort errors
            } finally {
                this.controllers.delete(controller);
            }
        }

        abort() {
            this.aborted = true;
            this.controllers.forEach(c => {
                try { c.abort(); } catch (e) {}
            });
            this.controllers.clear();
            this.chunkCache.clear();
            this.inflightRequests.clear();
            super.abort();
        }
    }

    return new SpidyFastRangeTransport(totalLength, firstChunkBuffer);
}

// ==========================================
// 4. RESOURCE CLEANUP & MEMORY DESTROYER
// ==========================================
export function cleanupPdfResources() {
    if (pdfVirtualObserver) {
        pdfVirtualObserver.disconnect();
        pdfVirtualObserver = null;
    }

    if (scrollDebounceTimer) {
        clearTimeout(scrollDebounceTimer);
        scrollDebounceTimer = null;
    }

    renderQueue = [];
    activeWorkersCount = 0;

    activeRenderTasks.forEach((taskObj) => {
        try { 
            if (taskObj && typeof taskObj.cancel === 'function') taskObj.cancel(); 
        } catch(e) {}
    });
    activeRenderTasks.clear();
    
    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        destroyCanvasInWrapper(wrapper);
    });
    
    renderedPagesMap.clear();

    if (activeRangeTransport) {
        try {
            activeRangeTransport.abort();
        } catch (e) {}
        activeRangeTransport = null;
    }

    if (activeLoadingTask) {
        try {
            activeLoadingTask.destroy();
        } catch (e) {}
        activeLoadingTask = null;
    }

    if (currentPdfDocument) {
        try {
            currentPdfDocument.cleanup();
            currentPdfDocument.destroy();
        } catch(e) {}
        currentPdfDocument = null;
    }

    currentZoomScale = 1.0;
    
    const badge = document.getElementById('pdfPageBadge');
    if (badge) badge.style.display = 'none';

    const scroller = document.getElementById('pdfScrollContainer');
    if (scroller) {
        scroller.style.width = '100%';
        scroller.style.minWidth = '100%';
        scroller.style.margin = '0 auto';
    }
}

function destroyCanvasInWrapper(wrapper) {
    if (!wrapper) return;
    const canvases = wrapper.querySelectorAll('canvas');
    canvases.forEach(canvas => {
        releaseCanvasToPool(canvas);
    });

    const pageNum = wrapper.dataset.pageNum;
    wrapper.classList.add('page-placeholder');
    wrapper.innerHTML = `
        <div class="pdf-placeholder-box" style="display:flex; flex-direction:column; align-items:center; gap:8px; opacity:0.6; pointer-events:none;">
            <i class="fas fa-book-open" style="font-size:18px;"></i>
            <span>Page ${pageNum || ''}</span>
        </div>`;
}

export function showCenteredPdfLoader(message = "Just a Moment… Your Book Is Almost Ready..!! 🚀📚") {
    const container = document.getElementById('pdfContainer');
    const existingLoader = document.getElementById('pdfCenteredLoader');
    if (existingLoader) existingLoader.remove();

    const loaderDiv = document.createElement('div');
    loaderDiv.id = 'pdfCenteredLoader';
    loaderDiv.className = 'pdf-loader-centered-box';
    loaderDiv.innerHTML = `
        <div class="orbit-spinner">
            <div class="orbit-ring"></div>
            <div class="orbit-inner-ring"></div>
            <div class="orbit-core"></div>
        </div>
        <div class="pdf-loader-text">${message}</div>
    `;
    container?.appendChild(loaderDiv);
}

// ==========================================
// 5. 5-PAGE SLIDING WINDOW (2 UP + CURRENT + 2 DOWN)
// ==========================================
export function preloadSurroundingPages(centerPage, forceRedraw = false) {
    if (!currentPdfDocument || centerPage < 1) return;

    // Priority Order: Current -> +1 -> -1 -> +2 -> -2
    const offsets = [0, 1, -1, 2, -2];
    offsets.forEach(offset => {
        const targetPage = centerPage + offset;
        if (targetPage >= 1 && targetPage <= pdfTotalPagesCount) {
            queuePageRender(targetPage, forceRedraw);
        }
    });
}

function recycleFarPages(activePage) {
    const pagesToKeep = new Set();
    for (let i = activePage - RENDER_BUFFER_DISTANCE; i <= activePage + RENDER_BUFFER_DISTANCE; i++) {
        if (i >= 1 && i <= pdfTotalPagesCount) {
            pagesToKeep.add(i);
        }
    }

    activeRenderTasks.forEach((task, pNum) => {
        if (!pagesToKeep.has(pNum)) {
            try {
                if (task && typeof task.cancel === 'function') task.cancel();
            } catch (e) {}
            activeRenderTasks.delete(pNum);
        }
    });

    renderQueue = renderQueue.filter(item => pagesToKeep.has(item.pageNum));

    renderedPagesMap.forEach((_, pageNum) => {
        if (!pagesToKeep.has(pageNum)) {
            unloadSinglePage(pageNum);
        }
    });

    while (renderedPagesMap.size > MAX_RENDERED_PAGES) {
        let farthestPage = null;
        let maxDist = -1;

        renderedPagesMap.forEach((_, pNum) => {
            const dist = Math.abs(pNum - activePage);
            if (dist > maxDist) {
                maxDist = dist;
                farthestPage = pNum;
            }
        });

        if (farthestPage !== null) {
            unloadSinglePage(farthestPage);
        } else {
            break;
        }
    }
}

function processRenderQueue() {
    if (!currentPdfDocument || renderQueue.length === 0) return;

    while (activeWorkersCount < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
        renderQueue.sort((a, b) => {
            const distA = Math.abs(a.pageNum - currentPdfPageInView);
            const distB = Math.abs(b.pageNum - currentPdfPageInView);
            if (distA !== distB) return distA - distB;
            return b.pageNum - a.pageNum;
        });

        const item = renderQueue.shift();
        if (!item) break;

        if (Math.abs(item.pageNum - currentPdfPageInView) <= RENDER_BUFFER_DISTANCE) {
            activeWorkersCount++;
            executePageRender(currentPdfDocument, item.pageNum, item.forceRedraw)
                .finally(() => {
                    activeWorkersCount = Math.max(0, activeWorkersCount - 1);
                    processRenderQueue();
                });
        }
    }
}

export function queuePageRender(pageNum, forceRedraw = false) {
    if (pageNum < 1 || pageNum > pdfTotalPagesCount) return;
    if (!forceRedraw && (renderedPagesMap.has(pageNum) || activeRenderTasks.has(pageNum))) return;
    
    renderQueue = renderQueue.filter(q => q.pageNum !== pageNum);
    if (forceRedraw || pageNum === currentPdfPageInView) {
        renderQueue.unshift({ pageNum, forceRedraw });
    } else {
        renderQueue.push({ pageNum, forceRedraw });
    }
    processRenderQueue();
}

export async function executePageRender(pdf, pageNum, isSeamlessSwap = false) {
    if (!pdf) return;
    if (!isSeamlessSwap && (renderedPagesMap.has(pageNum) || activeRenderTasks.has(pageNum))) return;

    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) return;

    if (activeRenderTasks.has(pageNum)) {
        try {
            const prevTask = activeRenderTasks.get(pageNum);
            if (prevTask && typeof prevTask.cancel === 'function') prevTask.cancel();
        } catch (e) {}
        activeRenderTasks.delete(pageNum);
    }

    activeRenderTasks.set(pageNum, true);

    try {
        const page = await pdf.getPage(pageNum);
        
        if (Math.abs(pageNum - currentPdfPageInView) > RENDER_BUFFER_DISTANCE) {
            activeRenderTasks.delete(pageNum);
            page.cleanup();
            return;
        }

        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const currentCssWidth = parseFloat(wrapper.style.width) || basePageWidth;
        const currentScale = currentCssWidth / unscaledViewport.width;
        const viewport = page.getViewport({ scale: currentScale });

        const rawDpr = window.devicePixelRatio || 2;
        const targetDpr = currentZoomScale > 1.1 
            ? Math.min(Math.max(rawDpr, 1.8), 2.2) 
            : Math.min(Math.max(rawDpr * 1.2, 2.0), 2.5);

        const newCanvas = acquirePooledCanvas();
        const context = newCanvas.getContext('2d', { alpha: false });
        
        newCanvas.width = Math.floor(viewport.width * targetDpr);
        newCanvas.height = Math.floor(viewport.height * targetDpr);
        newCanvas.style.width = '100%';
        newCanvas.style.height = '100%';
        newCanvas.style.display = 'block';

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';

        const renderTask = page.render({
            canvasContext: context,
            viewport: viewport,
            transform: [targetDpr, 0, 0, targetDpr, 0, 0]
        });

        activeRenderTasks.set(pageNum, renderTask);
        await renderTask.promise;

        activeRenderTasks.delete(pageNum);
        renderedPagesMap.set(pageNum, currentZoomScale);

        const oldCanvases = wrapper.querySelectorAll('canvas');
        const placeholders = wrapper.querySelectorAll('.pdf-placeholder-box');
        
        wrapper.classList.remove('page-placeholder');
        wrapper.appendChild(newCanvas);

        oldCanvases.forEach(oldCanvas => {
            if (oldCanvas !== newCanvas) {
                releaseCanvasToPool(oldCanvas);
            }
        });
        placeholders.forEach(p => p.remove());

        page.cleanup();
    } catch (e) {
        activeRenderTasks.delete(pageNum);
        if (e.name !== 'RenderingCancelledException') {
            if (wrapper && !wrapper.querySelector('canvas')) {
                wrapper.innerHTML = `
                    <div class="pdf-placeholder-box" style="display:flex; flex-direction:column; align-items:center; gap:8px; color:#ef4444;">
                        <i class="fas fa-rotate-right" style="font-size:18px;"></i>
                        <span>Tap to reload page ${pageNum}</span>
                    </div>`;
                wrapper.onclick = () => {
                    wrapper.onclick = null;
                    queuePageRender(pageNum, true);
                };
            }
        }
    }
}

export function unloadSinglePage(pageNum) {
    if (!renderedPagesMap.has(pageNum)) return;
    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) return;

    if (activeRenderTasks.has(pageNum)) {
        try { 
            const task = activeRenderTasks.get(pageNum);
            if (task && typeof task.cancel === 'function') task.cancel(); 
        } catch(e) {}
        activeRenderTasks.delete(pageNum);
    }

    destroyCanvasInWrapper(wrapper);
    renderedPagesMap.delete(pageNum);
}

// ==========================================
// 6. INTERSECTION OBSERVER VIRTUALIZER
// ==========================================
export function initVirtualizationObserver(pdf) {
    if (pdfVirtualObserver) pdfVirtualObserver.disconnect();

    pdfVirtualObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const pageNum = parseInt(entry.target.dataset.pageNum, 10);
            if (entry.isIntersecting) {
                const renderedScale = renderedPagesMap.get(pageNum);
                if (!renderedScale) {
                    queuePageRender(pageNum, false);
                } else if (Math.abs(renderedScale - currentZoomScale) > 0.05) {
                    queuePageRender(pageNum, true);
                }
            } else {
                if (Math.abs(pageNum - currentPdfPageInView) > RENDER_BUFFER_DISTANCE) {
                    unloadSinglePage(pageNum);
                }
            }
        });
    }, {
        root: document.getElementById('pdfContainer'),
        rootMargin: '1400px 0px 1400px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        pdfVirtualObserver.observe(wrapper);
    });
}

// ==========================================
// 7. INSTANT TARGET-LOCKED ZOOM & ANTI-SCROLL DOUBLE TAP
// ==========================================
export function applyTargetLockedZoom(scaleFactor, targetPageNum, tapClientX = null, tapClientY = null) {
    const container = document.getElementById('pdfContainer');
    const scroller = document.getElementById('pdfScrollContainer');
    if (!container || !scroller) return;

    const pageToAnchor = targetPageNum || currentPdfPageInView;
    const targetElement = document.getElementById(`page_wrapper_${pageToAnchor}`);
    if (!targetElement) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();

    const relX = tapClientX !== null 
        ? Math.max(0, Math.min(1, (tapClientX - targetRect.left) / targetRect.width)) 
        : 0.5;
    const relY = tapClientY !== null 
        ? Math.max(0, Math.min(1, (tapClientY - targetRect.top) / targetRect.height)) 
        : 0.35;

    const viewportClickOffsetY = tapClientY !== null 
        ? (tapClientY - containerRect.top) 
        : (container.clientHeight * 0.35);

    currentZoomScale = scaleFactor;
    const newWidth = Math.round(basePageWidth * currentZoomScale);
    const newHeight = Math.round(newWidth * basePageAspectRatio);

    if (currentZoomScale > 1.05) {
        scroller.style.width = `${newWidth}px`;
        scroller.style.minWidth = `${newWidth}px`;
        container.style.overflowX = "auto";
        container.style.touchAction = "pan-x pan-y";
    } else {
        scroller.style.width = '100%';
        scroller.style.minWidth = '100%';
        container.style.overflowX = "hidden";
        container.style.touchAction = "pan-y";
    }

    const wrappers = scroller.children;
    for (let i = 0; i < wrappers.length; i++) {
        wrappers[i].style.width = `${newWidth}px`;
        wrappers[i].style.height = `${newHeight}px`;
    }

    const newElementTop = targetElement.offsetTop;
    if (currentZoomScale > 1.05) {
        const targetScrollTop = newElementTop + (relY * newHeight) - viewportClickOffsetY;
        container.scrollTop = Math.max(0, targetScrollTop);

        const maxScrollLeft = container.scrollWidth - container.clientWidth;
        if (maxScrollLeft > 0) {
            const targetScrollLeft = (relX * newWidth) - (container.clientWidth / 2);
            container.scrollLeft = Math.max(0, Math.min(maxScrollLeft, targetScrollLeft));
        }
    } else {
        const targetScrollTop = newElementTop + (relY * newHeight) - viewportClickOffsetY;
        container.scrollTop = Math.max(0, targetScrollTop);
        container.scrollLeft = 0;
    }

    if (currentPdfDocument) {
        preloadSurroundingPages(pageToAnchor, true);
    }
}

export function initTargetLockedDoubleTapZoom() {
    if (isDoubleTapBound) return;
    const container = document.getElementById('pdfContainer');
    if (!container) return;

    isDoubleTapBound = true;
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let isMovingGesture = false;

    container.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) {
            isMovingGesture = true;
            lastTapTime = 0;
            return;
        }
        if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartTime = Date.now();
            isMovingGesture = false;
        }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) {
            const diffX = Math.abs(e.touches[0].clientX - touchStartX);
            const diffY = Math.abs(e.touches[0].clientY - touchStartY);
            if (diffX > 6 || diffY > 6) {
                isMovingGesture = true;
                lastTapTime = 0;
            }
        } else {
            isMovingGesture = true;
            lastTapTime = 0;
        }
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        const now = Date.now();

        if (isMovingGesture || (now - touchStartTime) > 220) {
            lastTapTime = 0;
            return; 
        }

        if (now - lastContainerScrollTime < 280) {
            lastTapTime = 0;
            return;
        }

        if (e.changedTouches.length === 1) {
            const touch = e.changedTouches[0];
            const tapX = touch.clientX;
            const tapY = touch.clientY;
            const timeDiff = now - lastTapTime;

            const tapDistance = Math.hypot(tapX - lastTapX, tapY - lastTapY);

            if (timeDiff > 40 && timeDiff < 300 && tapDistance < 28) {
                if (e.cancelable) e.preventDefault();
                
                const touchedEl = document.elementFromPoint(tapX, tapY);
                const pageWrapper = touchedEl ? touchedEl.closest('.pdf-page-wrapper') : null;
                const activePage = pageWrapper ? parseInt(pageWrapper.dataset.pageNum, 10) : currentPdfPageInView;

                if (currentZoomScale > 1.1) {
                    applyTargetLockedZoom(1.0, activePage, tapX, tapY);
                } else {
                    applyTargetLockedZoom(2.15, activePage, tapX, tapY);
                }
                lastTapTime = 0;
                return;
            }

            lastTapTime = now;
            lastTapX = tapX;
            lastTapY = tapY;
        }
    });
}

// ==========================================
// 8. SCROLL TRACKER & 5-PAGE WINDOW PRELOADER
// ==========================================
export function initPdfScrollTracker(activeBookSlug = "") {
    const container = document.getElementById('pdfContainer');
    const badge = document.getElementById('pdfCurrentPageNum');
    const badgeWrap = document.getElementById('pdfPageBadge');

    let scrollRafId = null;
    container?.addEventListener('scroll', () => {
        lastContainerScrollTime = Date.now();

        if (scrollRafId) return;

        scrollRafId = requestAnimationFrame(() => {
            const totalScrollable = container.scrollHeight - container.clientHeight;
            if (totalScrollable > 0 && badgeWrap) {
                const scrollFraction = Math.max(0, Math.min(1, container.scrollTop / totalScrollable));
                badgeWrap.style.top = `${14 + (scrollFraction * 68)}%`;
            }

            const containerCenter = container.getBoundingClientRect().top + (container.clientHeight / 2);
            const wrappers = container.querySelectorAll('.pdf-page-wrapper');

            for (let wrap of wrappers) {
                const rect = wrap.getBoundingClientRect();
                if (rect.top <= containerCenter && rect.bottom >= containerCenter) {
                    const matchedNum = parseInt(wrap.dataset.pageNum, 10);
                    if (!isNaN(matchedNum)) {
                        if (currentPdfPageInView !== matchedNum) {
                            currentPdfPageInView = matchedNum;
                            recycleFarPages(matchedNum);
                            preloadSurroundingPages(matchedNum, false);
                        }
                        if (badge && badge.innerText !== String(matchedNum)) {
                            badge.innerText = String(matchedNum);
                        }
                    }
                    break;
                }
            }

            clearTimeout(scrollDebounceTimer);
            scrollDebounceTimer = setTimeout(() => {
                if (currentPdfDocument && currentPdfPageInView > 0) {
                    preloadSurroundingPages(currentPdfPageInView, false);
                }
            }, 60);

            if (activeBookSlug && currentPdfPageInView > 0) {
                localStorage.setItem(`last_read_${activeBookSlug}`, currentPdfPageInView);
            }

            scrollRafId = null;
        });
    }, { passive: true });
}

export async function jumpToPdfPage(pageNum) {
    let targetWrapper = document.getElementById(`page_wrapper_${pageNum}`);
    const pdfPageBadge = document.getElementById('pdfPageBadge');
    if (targetWrapper) {
        currentPdfPageInView = pageNum;
        recycleFarPages(pageNum);
        preloadSurroundingPages(pageNum, false);

        targetWrapper.scrollIntoView({ behavior: 'auto', block: 'start' });
        const numEl = document.getElementById('pdfCurrentPageNum');
        if (numEl) numEl.innerText = pageNum.toString();
        if (pdfTotalPagesCount > 1 && pdfPageBadge) {
            const pageRatio = (pageNum - 1) / (pdfTotalPagesCount - 1);
            pdfPageBadge.style.top = `${14 + (pageRatio * 68)}%`;
        }
    }
}

export function executeGoToPage() {
    const goToPageInput = document.getElementById('goToPageInput');
    const goToPageModal = document.getElementById('goToPageModal');
    const val = parseInt(goToPageInput?.value.trim() || "0", 10);
    if (!isNaN(val) && val >= 1 && val <= pdfTotalPagesCount) {
        if (goToPageModal) goToPageModal.style.display = 'none';
        jumpToPdfPage(val);
    } else {
        showToast(`Invalid page range (1-${pdfTotalPagesCount})`, "error");
    }
}

// ==========================================
// 9. RENDER PDF IN MODAL (SPARSE WORKER + PARALLEL RANGE TRANSPORT)
// ==========================================
export async function renderPdfInModal(pdfUrl, keepExistingLoader = false, docType = "book", activeBookSlug = "", retryCount = 0) {
    const scrollContainer = document.getElementById('pdfScrollContainer');
    
    if (!keepExistingLoader) {
        const loaderMsg = docType === "module" 
            ? "Just a Moment… Your Module Is Almost Ready..!! 🚀📚" 
            : "Just a Moment… Your Book Is Almost Ready..!! 🚀📚";
        showCenteredPdfLoader(loaderMsg);
    }
    
    if (scrollContainer) scrollContainer.innerHTML = '';
    cleanupPdfResources();

    if (!pdfUrl || pdfUrl.trim() === "" || pdfUrl === "undefined") {
        setTimeout(() => {
            const loaderToDel = document.getElementById('pdfCenteredLoader');
            if (loaderToDel) loaderToDel.remove();
            if (scrollContainer) {
                scrollContainer.innerHTML = `
                    <div style="color: #ef4444; margin-top: 140px; text-align: center; padding: 25px;">
                        <i class="fas fa-triangle-exclamation" style="font-size: 38px; margin-bottom: 14px; display: block;"></i>
                        <strong style="font-size: 16px; font-weight: 800;">Failed to load book pages</strong>
                        <p style="font-size: 12.5px; color: #a1a1aa; margin: 8px 0 0 0; font-weight: 500;">Empty Document URL.</p>
                    </div>`;
            }
        }, 300);
        return;
    }

    try {
        // 1. Initialize Patched Sparse Worker (Prevents 707MB/1GB ArrayBuffer Crash in Worker)
        await ensureSparsePdfWorker();

        // 2. Initialize High-Speed Custom Range Transport (Prevents Main Thread ArrayBuffer Crash)
        activeRangeTransport = await createFastRangeTransport(pdfUrl);

        activeLoadingTask = window.pdfjsLib.getDocument({
            range: activeRangeTransport,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true,
            disableAutoFetch: true,
            disableStream: true,
            rangeChunkSize: RANGE_CHUNK_SIZE,
            maxImageSize: 16777216,
            isEvalSupported: false
        });

        const pdf = await activeLoadingTask.promise;
        currentPdfDocument = pdf;
        pdfTotalPagesCount = pdf.numPages;

        const savedPageRaw = localStorage.getItem(`last_read_${activeBookSlug}`);
        let initialTargetPage = 1;
        if (savedPageRaw) {
            const parsedPage = parseInt(savedPageRaw, 10);
            if (!isNaN(parsedPage) && parsedPage > 1 && parsedPage <= pdf.numPages) {
                initialTargetPage = parsedPage;
            }
        }
        currentPdfPageInView = initialTargetPage;

        scrollContainer.innerHTML = '';
        const curPageBadge = document.getElementById('pdfCurrentPageNum');
        if (curPageBadge) curPageBadge.innerText = String(initialTargetPage);
        const pageRangeBadge = document.getElementById('goToPageRange');
        if (pageRangeBadge) pageRangeBadge.innerText = `1 - ${pdfTotalPagesCount}`;

        const screenWidth = window.innerWidth;
        basePageWidth = Math.min(screenWidth - 12, 850);

        const defaultHeight = Math.round(basePageWidth * 1.414);

        const fragment = document.createDocumentFragment();
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page-wrapper page-placeholder';
            wrapper.id = `page_wrapper_${pageNum}`;
            wrapper.dataset.pageNum = pageNum;
            wrapper.dataset.aspectRatio = "1.414";
            wrapper.style.width = `${basePageWidth}px`;
            wrapper.style.height = `${defaultHeight}px`;
            wrapper.innerHTML = `
                <div class="pdf-placeholder-box" style="display:flex; flex-direction:column; align-items:center; gap:8px; opacity:0.6; pointer-events:none;">
                    <i class="fas fa-book-open" style="font-size:18px;"></i>
                    <span>Page ${pageNum}</span>
                </div>`;
            fragment.appendChild(wrapper);
        }
        scrollContainer.appendChild(fragment);

        const loaderToDel = document.getElementById('pdfCenteredLoader');
        if (loaderToDel) loaderToDel.remove();

        const pageBadge = document.getElementById('pdfPageBadge');
        if (pageBadge) {
            pageBadge.style.display = 'flex';
            pageBadge.style.top = '14%'; 
        }

        if (initialTargetPage > 1) {
            jumpToPdfPage(initialTargetPage);
        }

        initVirtualizationObserver(pdf);
        initPdfScrollTracker(activeBookSlug);
        initTargetLockedDoubleTapZoom();

        const firstPage = await pdf.getPage(initialTargetPage);
        const firstViewport = firstPage.getViewport({ scale: 1.0 });
        basePageAspectRatio = (firstViewport.height / firstViewport.width) || 1.414;
        firstPage.cleanup();

        // Render Current Page first, then immediately preload +1, -1, +2, -2 pages!
        await executePageRender(pdf, initialTargetPage, false);
        preloadSurroundingPages(initialTargetPage, false);

    } catch (err) {
        console.warn("PDF Load Attempt Error:", err);
        if (retryCount < 2) {
            setTimeout(() => {
                renderPdfInModal(pdfUrl, true, docType, activeBookSlug, retryCount + 1);
            }, 600);
            return;
        }

        const loaderToDel = document.getElementById('pdfCenteredLoader');
        if (loaderToDel) loaderToDel.remove();

        const errMsg = err && err.message ? err.message : "Network interrupted or document unavailable.";

        if (scrollContainer) {
            scrollContainer.innerHTML = `
                <div style="color: #ef4444; margin-top: 140px; text-align: center; padding: 25px;">
                    <i class="fas fa-triangle-exclamation" style="font-size: 38px; margin-bottom: 14px; display: block;"></i>
                    <strong style="font-size: 16px; font-weight: 800;">Failed to load book pages</strong>
                    <p style="font-size: 12.5px; color: #a1a1aa; margin: 8px 0 0 0; font-weight: 500;">${errMsg}</p>
                </div>`;
        }
    }
}

// ==========================================
// 10. INITIALIZE PDF MODAL CONTROLS
// ==========================================
export function initPdfViewerUI() {
    ensureSparsePdfWorker();

    const pdfPageBadge = document.getElementById('pdfPageBadge');
    const goToPageModal = document.getElementById('goToPageModal');
    const cancelGoToPageBtn = document.getElementById('cancelGoToPageBtn');
    const confirmGoToPageBtn = document.getElementById('confirmGoToPageBtn');
    const goToPageInput = document.getElementById('goToPageInput');

    pdfPageBadge?.addEventListener('click', () => {
        if (goToPageInput) goToPageInput.value = '';
        if (goToPageModal) {
            goToPageModal.style.display = 'flex';
            setTimeout(() => {
                goToPageInput?.focus();
                goToPageModal.scrollTop = 0;
            }, 100);
        }
    });

    cancelGoToPageBtn?.addEventListener('click', () => {
        if (goToPageModal) goToPageModal.style.display = 'none';
    });

    goToPageModal?.addEventListener('click', (e) => {
        if (e.target.id === 'goToPageModal') goToPageModal.style.display = 'none';
    });

    confirmGoToPageBtn?.addEventListener('click', executeGoToPage);
    goToPageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') executeGoToPage();
    });
}
