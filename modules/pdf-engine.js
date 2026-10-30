// File: modules/pdf-engine.js
// ULTRA-STREAM ENGINE v2.0 (256KB Micro-Chunking + 2-Stage HD Render + Zero-RAM Leak Pool)

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

// Strict Memory & Concurrency Controls (Mobile RAM Safe)
const MAX_RENDERED_PAGES = 4; 
const RENDER_BUFFER_DISTANCE = 1; 
let renderQueue = [];
let isQueueProcessing = false;
let lastContainerScrollTime = 0;
let activeLoadingTask = null;
let scrollDebounceTimer = null;

// Recycled Canvas Pool to prevent iOS/Android GPU crashes
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
        if (canvasRecyclePool.length < 6) {
            canvasRecyclePool.push(canvas);
        }
    } catch (e) {}
}

// ==========================================
// 2. RESOURCE CLEANUP & MEMORY DESTROYER
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
    isQueueProcessing = false;

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
// 3. SMART SLIDING WINDOW & TWO-STAGE HD RENDERER
// ==========================================
function recycleFarPages(activePage) {
    const pagesToKeep = new Set();
    for (let i = activePage - RENDER_BUFFER_DISTANCE; i <= activePage + RENDER_BUFFER_DISTANCE; i++) {
        if (i >= 1 && i <= pdfTotalPagesCount) {
            pagesToKeep.add(i);
        }
    }

    // Cancel any pending tasks for pages far away from current view
    activeRenderTasks.forEach((task, pNum) => {
        if (!pagesToKeep.has(pNum)) {
            try {
                if (task && typeof task.cancel === 'function') task.cancel();
            } catch (e) {}
            activeRenderTasks.delete(pNum);
        }
    });

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

async function processRenderQueue() {
    if (isQueueProcessing || renderQueue.length === 0) return;
    isQueueProcessing = true;

    while (renderQueue.length > 0) {
        // Always prioritize the page currently in front of the user's eyes
        renderQueue.sort((a, b) => Math.abs(a.pageNum - currentPdfPageInView) - Math.abs(b.pageNum - currentPdfPageInView));
        const item = renderQueue.shift();

        if (item && currentPdfDocument) {
            if (Math.abs(item.pageNum - currentPdfPageInView) <= RENDER_BUFFER_DISTANCE + 1) {
                await executePageRender(currentPdfDocument, item.pageNum, item.forceRedraw);
            }
        }
    }

    isQueueProcessing = false;
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
        
        // Check if user already scrolled far away while page metadata was fetching
        if (Math.abs(pageNum - currentPdfPageInView) > RENDER_BUFFER_DISTANCE + 1) {
            activeRenderTasks.delete(pageNum);
            page.cleanup();
            return;
        }

        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const currentCssWidth = parseFloat(wrapper.style.width) || basePageWidth;
        const currentScale = currentCssWidth / unscaledViewport.width;
        const viewport = page.getViewport({ scale: currentScale });

        const rawDpr = window.devicePixelRatio || 2;
        const hdDpr = currentZoomScale > 1.1 
            ? Math.min(Math.max(rawDpr, 1.8), 2.2) 
            : Math.min(Math.max(rawDpr * 1.25, 2.2), 2.75);

        // STAGE 1: Fast Instant Render (Only if wrapper has no existing canvas)
        const existingCanvas = wrapper.querySelector('canvas');
        if (!existingCanvas && !isSeamlessSwap) {
            const fastDpr = 1.0;
            const fastCanvas = acquirePooledCanvas();
            const fastCtx = fastCanvas.getContext('2d', { alpha: false });

            fastCanvas.width = Math.floor(viewport.width * fastDpr);
            fastCanvas.height = Math.floor(viewport.height * fastDpr);
            fastCanvas.style.width = '100%';
            fastCanvas.style.height = '100%';
            fastCanvas.style.display = 'block';

            const fastTask = page.render({
                canvasContext: fastCtx,
                viewport: viewport,
                transform: [fastDpr, 0, 0, fastDpr, 0, 0]
            });

            activeRenderTasks.set(pageNum, fastTask);
            await fastTask.promise;

            wrapper.classList.remove('page-placeholder');
            wrapper.querySelectorAll('.pdf-placeholder-box').forEach(p => p.remove());
            wrapper.appendChild(fastCanvas);
        }

        // Check again if user scrolled away before doing Stage 2 HD pass
        if (Math.abs(pageNum - currentPdfPageInView) > RENDER_BUFFER_DISTANCE + 1) {
            activeRenderTasks.delete(pageNum);
            renderedPagesMap.set(pageNum, currentZoomScale);
            page.cleanup();
            return;
        }

        // STAGE 2: Ultra-HD Crisp Pass
        const hdCanvas = acquirePooledCanvas();
        const hdContext = hdCanvas.getContext('2d', { alpha: false });
        
        hdCanvas.width = Math.floor(viewport.width * hdDpr);
        hdCanvas.height = Math.floor(viewport.height * hdDpr);
        hdCanvas.style.width = '100%';
        hdCanvas.style.height = '100%';
        hdCanvas.style.display = 'block';

        hdContext.imageSmoothingEnabled = true;
        hdContext.imageSmoothingQuality = 'high';

        const hdRenderTask = page.render({
            canvasContext: hdContext,
            viewport: viewport,
            transform: [hdDpr, 0, 0, hdDpr, 0, 0]
        });

        activeRenderTasks.set(pageNum, hdRenderTask);
        await hdRenderTask.promise;

        activeRenderTasks.delete(pageNum);
        renderedPagesMap.set(pageNum, currentZoomScale);

        const oldCanvases = wrapper.querySelectorAll('canvas');
        const placeholders = wrapper.querySelectorAll('.pdf-placeholder-box');
        
        wrapper.classList.remove('page-placeholder');
        wrapper.appendChild(hdCanvas);

        oldCanvases.forEach(oldCanvas => {
            if (oldCanvas !== hdCanvas) {
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
                        <i class="fas fa-triangle-exclamation" style="font-size:18px;"></i>
                        <span>Tap to retry page ${pageNum}</span>
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
// 4. INTERSECTION OBSERVER VIRTUALIZER
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
        rootMargin: '250px 0px 250px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        pdfVirtualObserver.observe(wrapper);
    });
}

// ==========================================
// 5. INSTANT TARGET-LOCKED ZOOM & ANTI-SCROLL DOUBLE TAP
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
        queuePageRender(pageToAnchor, true);
        if (pageToAnchor - 1 >= 1 && renderedPagesMap.has(pageToAnchor - 1)) {
            queuePageRender(pageToAnchor - 1, true);
        }
        if (pageToAnchor + 1 <= pdfTotalPagesCount && renderedPagesMap.has(pageToAnchor + 1)) {
            queuePageRender(pageToAnchor + 1, true);
        }
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
// 6. SCROLL TRACKER & RECYCLER OBSERVER
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
                        }
                        if (badge && badge.innerText !== String(matchedNum)) {
                            badge.innerText = String(matchedNum);
                        }
                    }
                    break;
                }
            }

            // Smart Debounce: Ensure current + next page render smoothly when fast scrolling stops
            clearTimeout(scrollDebounceTimer);
            scrollDebounceTimer = setTimeout(() => {
                if (currentPdfDocument && currentPdfPageInView > 0) {
                    queuePageRender(currentPdfPageInView, false);
                    if (currentPdfPageInView + 1 <= pdfTotalPagesCount) {
                        queuePageRender(currentPdfPageInView + 1, false);
                    }
                }
            }, 90);

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
        queuePageRender(pageNum, false);

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
// 7. RENDER PDF IN MODAL MAIN FUNCTION (1GB+ STREAMING READY)
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
                        <p style="font-size: 12.5px; color: #a1a1aa; margin: 8px 0 0 0; font-weight: 500;">Network interrupted or document unavailable.</p>
                    </div>`;
            }
        }, 300);
        return;
    }

    try {
        // ULTRA-FAST 256KB MICRO-STREAMING CONFIG FOR LARGE 300MB-1GB PDFs
        activeLoadingTask = window.pdfjsLib.getDocument({
            url: pdfUrl,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true,
            disableRange: false,
            disableAutoFetch: true,
            disableStream: false, // Streaming enabled so Page 1 opens immediately
            rangeChunkSize: 262144, // 256KB Fast Chunking for instant TTFB on slow networks
            maxImageSize: 16777216, // Cap decoded raw bitmaps to protect mobile RAM
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

        const firstPage = await pdf.getPage(initialTargetPage);
        const firstViewport = firstPage.getViewport({ scale: 1.0 });
        basePageAspectRatio = (firstViewport.height / firstViewport.width) || 1.414;
        const defaultHeight = Math.round(basePageWidth * basePageAspectRatio);
        firstPage.cleanup();

        const fragment = document.createDocumentFragment();
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page-wrapper page-placeholder';
            wrapper.id = `page_wrapper_${pageNum}`;
            wrapper.dataset.pageNum = pageNum;
            wrapper.dataset.aspectRatio = basePageAspectRatio.toString();
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

        // Remove loader immediately once layout & initial metadata are ready
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

        // Render initial target page immediately
        await executePageRender(pdf, initialTargetPage, false);
        if (initialTargetPage + 1 <= pdf.numPages) {
            queuePageRender(initialTargetPage + 1, false);
        }

    } catch (err) {
        console.warn("PDF Load Attempt Error:", err);
        if (retryCount < 2) {
            setTimeout(() => {
                renderPdfInModal(pdfUrl, true, docType, activeBookSlug, retryCount + 1);
            }, 700);
            return;
        }

        const loaderToDel = document.getElementById('pdfCenteredLoader');
        if (loaderToDel) loaderToDel.remove();

        if (scrollContainer) {
            scrollContainer.innerHTML = `
                <div style="color: #ef4444; margin-top: 140px; text-align: center; padding: 25px;">
                    <i class="fas fa-triangle-exclamation" style="font-size: 38px; margin-bottom: 14px; display: block;"></i>
                    <strong style="font-size: 16px; font-weight: 800;">Failed to load book pages</strong>
                    <p style="font-size: 12.5px; color: #a1a1aa; margin: 8px 0 0 0; font-weight: 500;">Network interrupted or document unavailable.</p>
                </div>`;
        }
    }
}

// ==========================================
// 8. INITIALIZE PDF MODAL CONTROLS
// ==========================================
export function initPdfViewerUI() {
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
