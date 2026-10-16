// File: modules/pdf-engine.js

import { showToast } from "./helpers.js";

// ==========================================
// PDF ENGINE STATE
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

// ==========================================
// CLEANUP & LOADER FUNCTIONS
// ==========================================
export function cleanupPdfResources() {
    if (pdfVirtualObserver) {
        pdfVirtualObserver.disconnect();
        pdfVirtualObserver = null;
    }
    activeRenderTasks.forEach((task) => {
        try { task.cancel(); } catch(e) {}
    });
    activeRenderTasks.clear();
    
    document.querySelectorAll('.pdf-page-wrapper canvas').forEach(canvas => {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
    });
    
    renderedPagesMap.clear();
    currentPdfDocument = null;
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
// PDF VIRTUALIZATION & RENDERING
// ==========================================
export function initVirtualizationObserver(pdf) {
    if (pdfVirtualObserver) pdfVirtualObserver.disconnect();

    pdfVirtualObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const pageNum = parseInt(entry.target.dataset.pageNum, 10);
            if (entry.isIntersecting) {
                renderSingleHdPage(pdf, pageNum);
                if (pageNum + 1 <= pdfTotalPagesCount && !renderedPagesMap.has(pageNum + 1)) {
                    window.requestIdleCallback 
                        ? window.requestIdleCallback(() => renderSingleHdPage(pdf, pageNum + 1)) 
                        : setTimeout(() => renderSingleHdPage(pdf, pageNum + 1), 60);
                }
            } else {
                if (Math.abs(pageNum - currentPdfPageInView) > 3) {
                    unloadSinglePage(pageNum);
                }
            }
        });
    }, {
        root: document.getElementById('pdfContainer'),
        rootMargin: '500px 0px 500px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        pdfVirtualObserver.observe(wrapper);
    });
}

export async function renderSingleHdPage(pdf, pageNum) {
    if (renderedPagesMap.has(pageNum) || activeRenderTasks.has(pageNum)) return; 
    activeRenderTasks.set(pageNum, true);

    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) {
        activeRenderTasks.delete(pageNum);
        return;
    }

    try {
        const page = await pdf.getPage(pageNum);
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const currentCssWidth = parseFloat(wrapper.style.width) || basePageWidth;
        const currentScale = currentCssWidth / unscaledViewport.width;
        
        const devicePR = Math.max(window.devicePixelRatio || 1, 1.8);
        const viewport = page.getViewport({ scale: currentScale });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false });
        
        canvas.width = Math.floor(viewport.width * devicePR);
        canvas.height = Math.floor(viewport.height * devicePR);
        canvas.style.width = `100%`;
        canvas.style.height = `100%`;

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

        const textContent = await page.getTextContent();
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.width = `100%`;
        textLayerDiv.style.height = `100%`;
        wrapper.appendChild(textLayerDiv);

        if (window.pdfjsLib && window.pdfjsLib.renderTextLayer) {
            await window.pdfjsLib.renderTextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport: viewport,
                textDivs: []
            }).promise;
        }

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
        try { activeRenderTasks.get(pageNum).cancel(); } catch(e) {}
        activeRenderTasks.delete(pageNum);
    }

    const canvas = wrapper.querySelector('canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
    }

    const textLayer = wrapper.querySelector('.textLayer');
    if (textLayer) textLayer.remove();

    wrapper.classList.add('page-placeholder');
    wrapper.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; gap:8px; opacity:0.6;">
            <i class="fas fa-book-open" style="font-size:18px;"></i>
            <span>Page ${pageNum}</span>
        </div>`;
    renderedPagesMap.delete(pageNum);
}

// ==========================================
// TARGET LOCKED ZOOM & DOUBLE TAP
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

    renderedPagesMap.clear();
    if (currentPdfDocument) {
        initVirtualizationObserver(currentPdfDocument);
        renderSingleHdPage(currentPdfDocument, pageToAnchor);
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
                    applyTargetLockedZoom(2.2, activePage);
                }
                lastTapTime = 0;
                return;
            }
            lastTapTime = now;
        }
    });
}

// ==========================================
// SCROLL TRACKER & PAGE JUMP
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
                        currentPdfPageInView = matchedNum;
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
        if (currentPdfDocument) {
            renderSingleHdPage(currentPdfDocument, pageNum);
        }
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
// RENDER PDF IN MODAL MAIN FUNCTION
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
        const loadingTask = window.pdfjsLib.getDocument({
            url: pdfUrl,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true,
            disableAutoFetch: true,
            disableStream: false,
            rangeChunkSize: 65536
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

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page-wrapper page-placeholder';
            wrapper.id = `page_wrapper_${pageNum}`;
            wrapper.dataset.pageNum = pageNum;
            wrapper.dataset.aspectRatio = basePageAspectRatio.toString();
            wrapper.style.width = `${basePageWidth}px`;
            wrapper.style.height = `${defaultHeight}px`;
            wrapper.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; gap:8px; opacity:0.6;">
                    <i class="fas fa-book-open" style="font-size:18px;"></i>
                    <span>Page ${pageNum}</span>
                </div>`;
            scrollContainer.appendChild(wrapper);
        }

        const pageBadge = document.getElementById('pdfPageBadge');
        if (pageBadge) {
            pageBadge.style.display = 'flex';
            pageBadge.style.top = '14%'; 
        }

        initVirtualizationObserver(pdf);
        initPdfScrollTracker(activeBookSlug);
        initTargetLockedDoubleTapZoom();

        await renderSingleHdPage(pdf, 1);
        if (pdf.numPages >= 2) renderSingleHdPage(pdf, 2);

        const savedPage = localStorage.getItem(`last_read_${activeBookSlug}`);
        if (savedPage) {
            const targetPage = parseInt(savedPage, 10);
            if (targetPage > 1 && targetPage <= pdf.numPages) {
                setTimeout(() => { 
                    renderSingleHdPage(pdf, targetPage);
                    jumpToPdfPage(targetPage); 
                }, 200);
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
// INITIALIZE PDF MODAL CONTROLS
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
