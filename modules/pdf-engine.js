// File: modules/pdf-engine.js

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

// Concurrency & Memory Controls (Adobe-Reader Style)
const MAX_RENDERED_PAGES = 5; // Phone memory me ek time par max 5 canvas rahenge
const RENDER_BUFFER_DISTANCE = 2; // Current page se aage-piche sirf 2 pages active rahenge
let renderQueue = [];
let isQueueProcessing = false;

// ==========================================
// 2. RESOURCE CLEANUP & MEMORY DESTROYER
// ==========================================
export function cleanupPdfResources() {
    if (pdfVirtualObserver) {
        pdfVirtualObserver.disconnect();
        pdfVirtualObserver = null;
    }

    renderQueue = [];
    isQueueProcessing = false;

    activeRenderTasks.forEach((task) => {
        try { 
            if (task && typeof task.cancel === 'function') task.cancel(); 
        } catch(e) {}
    });
    activeRenderTasks.clear();
    
    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        destroyCanvasInWrapper(wrapper);
    });
    
    renderedPagesMap.clear();

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
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
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
// 3. SMART SLIDING WINDOW & QUEUED RENDERER
// ==========================================
function recycleFarPages(activePage) {
    const pagesToKeep = new Set();
    for (let i = activePage - RENDER_BUFFER_DISTANCE; i <= activePage + RENDER_BUFFER_DISTANCE; i++) {
        if (i >= 1 && i <= pdfTotalPagesCount) {
            pagesToKeep.add(i);
        }
    }

    // Jo pages current view se door hain unhe turant RAM se delete karo
    renderedPagesMap.forEach((_, pageNum) => {
        if (!pagesToKeep.has(pageNum)) {
            unloadSinglePage(pageNum);
        }
    });

    // Agar kisi vajah se 5 se zyada canvas bache hon toh farthest remove karo
    if (renderedPagesMap.size > MAX_RENDERED_PAGES) {
        let farthestPage = null;
        let maxDist = -1;

        renderedPagesMap.forEach((_, pNum) => {
            const dist = Math.abs(pNum - activePage);
            if (dist > maxDist) {
                maxDist = dist;
                farthestPage = pNum;
            }
        });

        if (farthestPage) unloadSinglePage(farthestPage);
    }
}

async function processRenderQueue() {
    if (isQueueProcessing || renderQueue.length === 0) return;
    isQueueProcessing = true;

    while (renderQueue.length > 0) {
        const item = renderQueue.shift();
        if (item && currentPdfDocument) {
            // Check karein ki kya page abhi bhi current viewport buffer ke paas hai
            if (Math.abs(item.pageNum - currentPdfPageInView) <= RENDER_BUFFER_DISTANCE + 1) {
                await executePageRender(currentPdfDocument, item.pageNum);
            }
        }
    }

    isQueueProcessing = false;
}

export function queuePageRender(pageNum) {
    if (renderedPagesMap.has(pageNum) || activeRenderTasks.has(pageNum)) return;
    if (!renderQueue.some(q => q.pageNum === pageNum)) {
        renderQueue.push({ pageNum });
        processRenderQueue();
    }
}

async function executePageRender(pdf, pageNum) {
    if (!pdf || renderedPagesMap.has(pageNum) || activeRenderTasks.has(pageNum)) return;

    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) return;

    activeRenderTasks.set(pageNum, true);

    try {
        const page = await pdf.getPage(pageNum);
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const currentCssWidth = parseFloat(wrapper.style.width) || basePageWidth;
        const currentScale = currentCssWidth / unscaledViewport.width;
        
        // Mobile RAM freeze se bachne ke liye safe DPR capping (max 2.0)
        const devicePR = Math.min(window.devicePixelRatio || 1, 2.0);
        const viewport = page.getViewport({ scale: currentScale });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false });
        
        canvas.width = Math.floor(viewport.width * devicePR);
        canvas.height = Math.floor(viewport.height * devicePR);
        canvas.style.width = `100%`;
        canvas.style.height = `100%`;
        canvas.style.display = 'block';

        const renderTask = page.render({
            canvasContext: context,
            viewport: viewport,
            transform: [devicePR, 0, 0, devicePR, 0, 0]
        });

        activeRenderTasks.set(pageNum, renderTask);
        await renderTask.promise;

        activeRenderTasks.delete(pageNum);
        renderedPagesMap.set(pageNum, true);

        wrapper.classList.remove('page-placeholder');
        wrapper.innerHTML = '';
        wrapper.appendChild(canvas);

        page.cleanup(); // Clean up internal page operator memory
    } catch (e) {
        if (e.name !== 'RenderingCancelledException') {
            renderedPagesMap.delete(pageNum);
            activeRenderTasks.delete(pageNum);
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
                queuePageRender(pageNum);
                
                // Pre-render agla page smoothly
                if (pageNum + 1 <= pdfTotalPagesCount && !renderedPagesMap.has(pageNum + 1)) {
                    queuePageRender(pageNum + 1);
                }
            } else {
                if (Math.abs(pageNum - currentPdfPageInView) > RENDER_BUFFER_DISTANCE) {
                    unloadSinglePage(pageNum);
                }
            }
        });
    }, {
        root: document.getElementById('pdfContainer'),
        rootMargin: '300px 0px 300px 0px',
        threshold: 0.02
    });

    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        pdfVirtualObserver.observe(wrapper);
    });
}

// ==========================================
// 5. TARGET LOCKED ZOOM & DOUBLE TAP
// ==========================================
export function applyTargetLockedZoom(scaleFactor, targetPageNum) {
    const container = document.getElementById('pdfContainer');
    const scroller = document.getElementById('pdfScrollContainer');
    if (!container || !scroller) return;

    const pageToAnchor = targetPageNum || currentPdfPageInView;
    const targetElement = document.getElementById(`page_wrapper_${pageToAnchor}`);
    const initialOffsetTop = targetElement ? (targetElement.getBoundingClientRect().top - container.getBoundingClientRect().top) : 0;

    currentZoomScale = scaleFactor;
    const newWidth = Math.round(basePageWidth * currentZoomScale);
    const newHeight = Math.round(newWidth * basePageAspectRatio);

    if (currentZoomScale > 1.05) {
        scroller.style.width = `${newWidth}px`;
        scroller.style.minWidth = `${newWidth}px`;
        container.style.overflowX = "auto";
        container.style.touchAction = "pan-x pan-y pinch-zoom";
    } else {
        scroller.style.width = '100%';
        scroller.style.minWidth = '100%';
        container.style.overflowX = "hidden";
        container.style.touchAction = "pan-y pinch-zoom";
    }

    const wrappers = scroller.children;
    for (let i = 0; i < wrappers.length; i++) {
        wrappers[i].style.width = `${newWidth}px`;
        wrappers[i].style.height = `${newHeight}px`;
    }

    // Zoom badalne par sabhi pages ko refresh karo
    renderedPagesMap.forEach((_, pNum) => unloadSinglePage(pNum));
    renderedPagesMap.clear();

    if (currentPdfDocument) {
        queuePageRender(pageToAnchor);
    }

    if (targetElement) {
        requestAnimationFrame(() => {
            const newElementTop = targetElement.offsetTop;
            if (currentZoomScale > 1.05) {
                container.scrollTop = newElementTop - 10;
                const maxScrollLeft = container.scrollWidth - container.clientWidth;
                if (maxScrollLeft > 0) {
                    container.scrollLeft = maxScrollLeft / 2;
                }
            } else {
                container.scrollTop = newElementTop - Math.max(0, initialOffsetTop);
                container.scrollLeft = 0;
            }
        });
    }
}

export function initTargetLockedDoubleTapZoom() {
    if (isDoubleTapBound) return;
    const container = document.getElementById('pdfContainer');
    if (!container) return;

    isDoubleTapBound = true;
    let lastTapTime = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let isMovingGesture = false;

    container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isMovingGesture = false;
        }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) {
            const diffX = Math.abs(e.touches[0].clientX - touchStartX);
            const diffY = Math.abs(e.touches[0].clientY - touchStartY);
            if (diffX > 8 || diffY > 8) {
                isMovingGesture = true;
            }
        }
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        if (isMovingGesture) {
            lastTapTime = 0;
            return; 
        }

        if (e.changedTouches.length === 1) {
            const now = Date.now();
            const timeDiff = now - lastTapTime;

            if (timeDiff > 0 && timeDiff < 280) {
                if (e.cancelable) e.preventDefault();
                const touch = e.changedTouches[0];
                const touchedEl = document.elementFromPoint(touch.clientX, touch.clientY);
                const pageWrapper = touchedEl ? touchedEl.closest('.pdf-page-wrapper') : null;
                const activePage = pageWrapper ? parseInt(pageWrapper.dataset.pageNum, 10) : currentPdfPageInView;

                if (currentZoomScale > 1.1) {
                    applyTargetLockedZoom(1.0, activePage);
                } else {
                    applyTargetLockedZoom(2.0, activePage);
                }
                lastTapTime = 0;
                return;
            }
            lastTapTime = now;
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
                            recycleFarPages(matchedNum); // Active page badalte hi door ke canvas recycle karo
                        }
                        if (badge && badge.innerText !== String(matchedNum)) {
                            badge.innerText = String(matchedNum);
                        }
                    }
                    break;
                }
            }

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
        queuePageRender(pageNum);

        targetWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
// 7. RENDER PDF IN MODAL MAIN FUNCTION
// ==========================================
export async function renderPdfInModal(pdfUrl, keepExistingLoader = false, docType = "book", activeBookSlug = "") {
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
        // Optimized PDF.js loading parameters: Byte Range Chunky Streaming for Cloudflare R2
        const loadingTask = window.pdfjsLib.getDocument({
            url: pdfUrl,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true,
            disableAutoFetch: true,       // Puri file ek sath download hone se rokega (Saves Bandwidth)
            disableStream: false,         // On-demand streaming allow karega
            rangeChunkSize: 262144        // 256 KB Range Chunks (Optimal balance of speed & requests)
        });

        const pdf = await loadingTask.promise;
        currentPdfDocument = pdf;
        pdfTotalPagesCount = pdf.numPages;

        const loaderToDel = document.getElementById('pdfCenteredLoader');
        if (loaderToDel) loaderToDel.remove();

        scrollContainer.innerHTML = '';
        document.getElementById('pdfCurrentPageNum').innerText = `1`;
        document.getElementById('goToPageRange').innerText = `1 - ${pdfTotalPagesCount}`;

        const screenWidth = window.innerWidth;
        basePageWidth = Math.min(screenWidth - 12, 850);

        const firstPage = await pdf.getPage(1);
        const firstViewport = firstPage.getViewport({ scale: 1.0 });
        basePageAspectRatio = (firstViewport.height / firstViewport.width) || 1.414;
        const defaultHeight = Math.round(basePageWidth * basePageAspectRatio);
        firstPage.cleanup();

        // Document fragment create karke DOM batch insert karein (Fastest Layout Creation)
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

        const pageBadge = document.getElementById('pdfPageBadge');
        if (pageBadge) {
            pageBadge.style.display = 'flex';
            pageBadge.style.top = '14%'; 
        }

        initVirtualizationObserver(pdf);
        initPdfScrollTracker(activeBookSlug);
        initTargetLockedDoubleTapZoom();

        // Initial active pages queue karein
        queuePageRender(1);
        if (pdf.numPages >= 2) queuePageRender(2);

        const savedPage = localStorage.getItem(`last_read_${activeBookSlug}`);
        if (savedPage) {
            const targetPage = parseInt(savedPage, 10);
            if (targetPage > 1 && targetPage <= pdf.numPages) {
                setTimeout(() => { 
                    jumpToPdfPage(targetPage); 
                }, 150);
            } else {
                jumpToPdfPage(1);
            }
        } else {
            jumpToPdfPage(1);
        }

    } catch (err) {
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
