// File: app.js

import { 
    auth, db, collection, addDoc, doc, getDoc, getDocs, 
    query, where, orderBy, limit, startAfter, serverTimestamp, onAuthStateChanged, onSnapshot 
} from "./modules/firebase-config.js";

import { 
    getSecureAssetUrl, generateCleanSlug, sanitizeHTML, escapeHTML, 
    showToast, DEFAULT_AVATAR, getHighQualityAvatar, generateDeviceFingerprint 
} from "./modules/helpers.js";

import { 
    triggerLoginModal, initAuthSystem, handleFastTokenClose 
} from "./modules/auth-system.js";

import { 
    filterState, allAuthorsCache, allYearsCache, fetchGlobalFilterMetadata, 
    matchBookFilters, initFiltersEngine, closeMainFilterModal, closeSubFilterModal 
} from "./modules/filters-engine.js";

import { 
    cleanupPdfResources, showCenteredPdfLoader, renderPdfInModal, 
    initPdfViewerUI 
} from "./modules/pdf-engine.js";

import { 
    initUploadPipeline 
} from "./modules/upload-pipeline.js";

// Linked Channel Engine Module
import { 
    initChannelEngine, renderChannelFeed, renderChannelLoader, 
    checkAndOpenTargetPost, pendingTargetPostId, livePosts 
} from "./modules/channel-engine.js";

// ==========================================
// API CONFIGURATION
// ==========================================
const SPIDY_API_WORKER_URL = "https://spidy-api.spidybookhub.workers.dev";

// ==========================================
// 1. GLOBAL APP STATE & CONSTANTS
// ==========================================
let booksData = [];
let mainFilteredData = [];
let lastVisibleBookDoc = null;
let hasMoreBooksToFetch = true;
let isFetchingBooksBatch = false;
const BATCH_SIZE = 12;

let activeBookSlug = ""; 
let activeBookId = "";
let activeBookTitle = "";

let IS_SUPER_ADMIN = false;
let isUserLoggedIn = false; 

let CURRENT_ADMIN_NAME = "Guest User";
let CURRENT_ADMIN_EMAIL = "";
let CURRENT_ADMIN_PHOTO = DEFAULT_AVATAR;

let savedBooks = [];
try {
    const rawSaved = JSON.parse(localStorage.getItem('spidy_saved_books'));
    savedBooks = Array.isArray(rawSaved) ? rawSaved : [];
} catch (e) {
    savedBooks = [];
}

let dynamicBannersList = [];
let activeBannerData = null;
let activeSubjectKey = null;

let isAppReady = { auth: false, data: false }; 
let hasTransitioned = false;
let isTransitioning = false;
let loadingProgress = 5;
let loaderInterval = null;
let hasRealtimeListenersBound = false;

// Concurrency locks
let isRequestingPdf = false;
let isSubmittingReport = false;
let searchDebounceTimer = null;

// URL Check for Direct Deeplinks
const urlParamsCheck = new URLSearchParams(window.location.search);
let isDeepLinkLoad = urlParamsCheck.has('book'); 
let pendingBookSlug = urlParamsCheck.get('book');

// Community Popup Controls
let communityJoinState = { wa: false, tg: false, ig: false };
try {
    const cachedComm = JSON.parse(localStorage.getItem('spidy_community_state'));
    if (cachedComm && typeof cachedComm === 'object') {
        communityJoinState = { ...communityJoinState, ...cachedComm };
    }
} catch (e) {}

let isJoiningWA = false;
let isJoiningTG = false;
let isJoiningIG = false;
let communityPopupTimer = null;

const VERIFIED_CHECK_SVG = `
<svg class="premium-verified-tick" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="10" fill="#10b981" fill-opacity="0.2" stroke="#10b981" stroke-width="2"/>
    <path d="M8 12.5L10.5 15L16 9.5" stroke="#34d399" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Helper: Remove lingering grey hover/focus boxes on mobile
function clearActiveElementFocus() {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
    }
}

// Helper: Safe History Push
function safePushHistory(stateObj, url = '') {
    if (window.history.state && window.history.state.popup === stateObj.popup) {
        return;
    }
    window.history.pushState(stateObj, '', url || window.location.href);
}

// Helper: Check if any filter or search query is currently active
function isFilterOrSearchActive() {
    const searchVal = (document.getElementById('app-search-input')?.value || "").trim();
    return (
        searchVal.length > 0 ||
        filterState.language !== 'All' ||
        filterState.class !== 'All' ||
        filterState.author !== 'All' ||
        filterState.year !== 'All'
    );
}

// Helper: Optimize GPU Repaint & Pause Slider during Modals
function toggleBackgroundFreeze(isFrozen) {
    const mainArea = document.getElementById('mainContentArea');
    if (isFrozen) {
        if (promoAutoSlideInterval) {
            clearInterval(promoAutoSlideInterval);
            promoAutoSlideInterval = null;
        }
        if (mainArea) mainArea.style.overflow = 'hidden';
        document.body.classList.add('modal-open-gpu-lock');
    } else {
        if (mainArea) mainArea.style.overflow = '';
        document.body.classList.remove('modal-open-gpu-lock');
        initPromoCarousel();
    }
}

// ==========================================
// 2. ULTRA-FAST LOADER & TRANSITION ENGINE
// ==========================================
function updateLoaderUI(percent) {
    const loaderFill = document.getElementById('loaderFill');
    const loaderPercentage = document.getElementById('loaderPercentage');
    const loaderStatusText = document.getElementById('loaderStatusText');
    if (loaderFill) loaderFill.style.width = percent + "%";
    if (loaderPercentage) loaderPercentage.innerText = Math.floor(percent) + "%";
    if (loaderStatusText) {
        if (percent < 30) loaderStatusText.innerText = "Initializing System...";
        else if (percent < 70) loaderStatusText.innerText = "Loading Books Securely...";
        else if (percent < 95) loaderStatusText.innerText = "Preparing Content...";
        else loaderStatusText.innerText = "Ready to Launch!";
    }
}

function runSmoothLoaderTick() {
    if (hasTransitioned || isTransitioning) return;

    if (loadingProgress < 40) {
        loadingProgress += 3;
    } else if (loadingProgress < 80) {
        loadingProgress += 2;
    } else if (loadingProgress < 95) {
        loadingProgress += (isAppReady.data || isAppReady.auth) ? 2 : 0.5;
    }

    if (loadingProgress > 95 && (!isAppReady.data && !isAppReady.auth)) {
        loadingProgress = 95;
    }

    updateLoaderUI(Math.min(95, loadingProgress));

    // Agar data aa chuka hai toh wait mat karo, turant transition karo
    if (isAppReady.data || (isAppReady.auth && loadingProgress >= 80)) {
        tryTransition();
    } else {
        loaderInterval = setTimeout(runSmoothLoaderTick, 35);
    }
}

// Loader Tick turant start karo
updateLoaderUI(5);
loaderInterval = setTimeout(runSmoothLoaderTick, 25);

// Fail-safe: Maximum 3.5 second me loader har haal me hatega
setTimeout(() => {
    if (!hasTransitioned) {
        isAppReady.auth = true;
        isAppReady.data = true;
        tryTransition();
    }
}, 3500);

function tryTransition() {
    if (hasTransitioned || isTransitioning) return;
    isTransitioning = true;
    if (loaderInterval) clearTimeout(loaderInterval);

    let finishStep = setInterval(() => {
        loadingProgress += 4;
        if (loadingProgress >= 100) {
            loadingProgress = 100;
            updateLoaderUI(100);
            clearInterval(finishStep);
            hasTransitioned = true;
            isTransitioning = false;

            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';

            const loader = document.getElementById("loaderScreen");
            if (loader) {
                loader.style.opacity = "0"; 
                loader.style.transition = "opacity 0.25s ease-out";
                setTimeout(() => { 
                    loader.style.display = "none"; 
                    if (pendingTargetPostId) {
                        checkAndOpenTargetPost();
                    }
                }, 250);
            }

            if (isDeepLinkLoad && pendingBookSlug) {
                if (isUserLoggedIn) { 
                    openDownloadPageLocal(pendingBookSlug, true); 
                } else {
                    triggerLoginModal();
                }
            } else if (!pendingTargetPostId) {
                initCommunityDualPopup(); 
            }
        } else {
            updateLoaderUI(loadingProgress);
        }
    }, 15);
}

// ==========================================
// 3. BOOKMARK CACHE SANITIZER
// ==========================================
function syncAndSanitizeBookmarks() {
    if (!Array.isArray(savedBooks)) {
        savedBooks = [];
    }
    localStorage.setItem('spidy_saved_books', JSON.stringify(savedBooks));
}

function isBookMarked(bookOrIdentifier) {
    if (!bookOrIdentifier) return false;
    const targetKey = typeof bookOrIdentifier === 'string' ? bookOrIdentifier : (bookOrIdentifier.slug || bookOrIdentifier.id);
    return savedBooks.some(item => {
        if (typeof item === 'string') return item === targetKey;
        return item && (item.slug === targetKey || item.id === targetKey);
    });
}

// ==========================================
// 4. COMMUNITY POPUP ENGINE
// ==========================================
function initCommunityDualPopup() {
    const popup = document.getElementById('communityPopup');
    if (!popup) return;

    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const lastLockedTime = localStorage.getItem('spidy_community_popup_locked_until');
    const now = Date.now();

    if (lastLockedTime && now < parseInt(lastLockedTime, 10)) return;

    clearTimeout(communityPopupTimer);
    communityPopupTimer = setTimeout(() => {
        popup.classList.add('active');
    }, 120000);

    const waCard = document.getElementById('btnJoinWhatsApp');
    const tgCard = document.getElementById('btnJoinTelegram');
    const igCard = document.getElementById('btnJoinInstagram');

    const waStatus = document.getElementById('waStatusBtn');
    const tgStatus = document.getElementById('tgStatusBtn');
    const igStatus = document.getElementById('igStatusBtn');
    const maybeLaterBtn = document.getElementById('communityMaybeLaterBtn');

    if (communityJoinState.wa && waStatus) {
        waStatus.classList.add('completed');
        waStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
    }
    if (communityJoinState.tg && tgStatus) {
        tgStatus.classList.add('completed');
        tgStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
    }
    if (communityJoinState.ig && igStatus) {
        igStatus.classList.add('completed');
        igStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
    }

    function checkAndComplete() {
        localStorage.setItem('spidy_community_state', JSON.stringify(communityJoinState));
        if (communityJoinState.wa && communityJoinState.tg && communityJoinState.ig) {
            localStorage.setItem('spidy_community_popup_locked_until', (Date.now() + THREE_DAYS_MS).toString());
            showToast("Community joined successfully!", "success");
            setTimeout(() => { popup.classList.remove('active'); }, 800);
        }
    }

    if (waCard) {
        waCard.onclick = (e) => {
            e.preventDefault();
            if (communityJoinState.wa || isJoiningWA) return;
            isJoiningWA = true;

            if (waStatus) {
                waStatus.style.pointerEvents = "none";
                waStatus.innerHTML = `<span>Joining...</span> <i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>`;
            }

            window.open('https://whatsapp.com/channel/0029Vb6NBZx1yT2GByTTVf2A', '_blank');

            setTimeout(() => {
                communityJoinState.wa = true;
                isJoiningWA = false;
                if (waStatus) {
                    waStatus.classList.add('completed');
                    waStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
                }
                checkAndComplete();
            }, 6000);
        };
    }

    if (tgCard) {
        tgCard.onclick = (e) => {
            e.preventDefault();
            if (communityJoinState.tg || isJoiningTG) return;
            isJoiningTG = true;

            if (tgStatus) {
                tgStatus.style.pointerEvents = "none";
                tgStatus.innerHTML = `<span>Joining...</span> <i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>`;
            }

            window.open('https://t.me/+wJgG-_oBsHkxYTRl', '_blank');

            setTimeout(() => {
                communityJoinState.tg = true;
                isJoiningTG = false;
                if (tgStatus) {
                    tgStatus.classList.add('completed');
                    tgStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
                }
                checkAndComplete();
            }, 6000);
        };
    }

    if (igCard) {
        igCard.onclick = (e) => {
            e.preventDefault();
            if (communityJoinState.ig || isJoiningIG) return;
            isJoiningIG = true;

            if (igStatus) {
                igStatus.style.pointerEvents = "none";
                igStatus.innerHTML = `<span>Following...</span> <i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>`;
            }

            window.open('https://www.instagram.com/princeyadav_3030', '_blank');

            setTimeout(() => {
                communityJoinState.ig = true;
                isJoiningIG = false;
                if (igStatus) {
                    igStatus.classList.add('completed');
                    igStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
                }
                checkAndComplete();
            }, 6000);
        };
    }

    if (maybeLaterBtn) {
        maybeLaterBtn.onclick = (e) => {
            e.preventDefault();
            if (!communityJoinState.wa || !communityJoinState.tg || !communityJoinState.ig) {
                showToast("Please follow all channels to continue", "error");
                return;
            }
            popup.classList.remove('active');
        };
    }
}

// ==========================================
// 5. MASTER FILTER APPLIER & UI RENDER
// ==========================================
function applyMasterFilter(isAppending = false, newBatchData = []) {
    const searchInputRaw = (document.getElementById('app-search-input')?.value || "").trim();
    const rawLower = searchInputRaw.toLowerCase();
    const cleanSearchNoSpaces = rawLower.replace(/[^\p{L}\p{N}]/gu, '');
    const searchWords = rawLower.split(/\s+/).filter(w => w.length > 0);

    const infiniteLoader = document.getElementById('infinite-loader');
    const noResultsMsg = document.getElementById('no-results-msg');
    const bookContainer = document.getElementById("bookContainer");

    if (isAppending && newBatchData.length > 0) {
        const filteredNewItems = newBatchData.filter(book => 
            matchBookFilters(book, searchInputRaw, cleanSearchNoSpaces, searchWords)
        );
        mainFilteredData.push(...filteredNewItems);
        renderBooksUI(filteredNewItems, true);

        if (mainFilteredData.length > 0) {
            if (noResultsMsg) noResultsMsg.style.display = 'none';
        } else if (!hasMoreBooksToFetch) {
            if (noResultsMsg) noResultsMsg.style.display = 'flex';
        }

        if (infiniteLoader) infiniteLoader.style.display = 'none';

        if (isFilterOrSearchActive() && mainFilteredData.length < 6 && hasMoreBooksToFetch && !isFetchingBooksBatch) {
            loadNextBooksBatch(true);
        }
        return;
    }

    mainFilteredData = booksData.filter(book => 
        matchBookFilters(book, searchInputRaw, cleanSearchNoSpaces, searchWords)
    );
    
    if (mainFilteredData.length > 0) { 
        if (noResultsMsg) noResultsMsg.style.display = 'none'; 
        if (infiniteLoader) infiniteLoader.style.display = 'none';
        renderBooksUI(mainFilteredData, false); 
    } else { 
        if (bookContainer) bookContainer.innerHTML = ""; 
        if (!hasMoreBooksToFetch) {
            if (noResultsMsg) noResultsMsg.style.display = 'flex'; 
        } else {
            if (noResultsMsg) noResultsMsg.style.display = 'none';
        }
        if (infiniteLoader) infiniteLoader.style.display = 'none';
    }

    if (isFilterOrSearchActive() && mainFilteredData.length < 6 && hasMoreBooksToFetch && !isFetchingBooksBatch) {
        loadNextBooksBatch(true);
    }
}

window.handleBookCoverError = function(imgElement, originalUrl) {
    if (!imgElement) return;
    if (!imgElement.dataset.retried) {
        imgElement.dataset.retried = "true";
        setTimeout(() => {
            imgElement.src = originalUrl + (originalUrl.includes('?') ? '&' : '?') + 'retry=' + Date.now();
        }, 1200);
    } else {
        imgElement.src = DEFAULT_AVATAR;
    }
};

function renderBooksUI(dataToRender, append = false) {
    const container = document.getElementById("bookContainer");
    if (!container) return;
    let htmlChunk = "";

    dataToRender.forEach((book, idx) => {
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        let isSaved = isBookMarked(book);
        let bookmarkIcon = isSaved ? 'fas fa-bookmark' : 'far fa-bookmark';
        const secureCoverUrl = getSecureAssetUrl(book.image);
        
        const loadStrategy = (!append && idx < 4) ? 'eager' : 'lazy';

        htmlChunk += `
        <div class="book-card" data-slug="${escapeHTML(book.slug || '')}" data-id="${escapeHTML(book.id || '')}">
            <div class="card-img-wrapper">
                <div class="badge-free">FREE</div>
                <div class="bookmark-btn" data-action="bookmark"><i class="${bookmarkIcon}"></i></div>
                <img src="${secureCoverUrl}" loading="${loadStrategy}" decoding="async" class="book-image" onerror="window.handleBookCoverError(this, '${escapeHTML(secureCoverUrl)}')" oncontextmenu="return false;" draggable="false">
            </div>
            <div class="book-details">
                <div class="book-title">${sanitizeHTML(book.title || '')}</div>
                <div class="book-author">${sanitizeHTML(book.author || '')}</div>
                <div class="tags-container">
                    <span class="book-tag tag-year">${sanitizeHTML(book.year ? book.year.toString() : '')}</span>
                    <span class="book-tag ${langClass}">${sanitizeHTML(book.lang || '')}</span>
                </div>
            </div>
        </div>`;
    });

    if (append) {
        container.insertAdjacentHTML('beforeend', htmlChunk);
    } else {
        container.innerHTML = htmlChunk;
    }
}

function toggleBookmarkLocal(iconElement, bookIdentifier, optionalFullBook = null) {
    const targetKey = typeof bookIdentifier === 'string' ? bookIdentifier : (bookIdentifier.slug || bookIdentifier.id);
    const existingIndex = savedBooks.findIndex(item => {
        if (typeof item === 'string') return item === targetKey;
        return item && (item.slug === targetKey || item.id === targetKey);
    });

    if (existingIndex === -1) {
        const bookObj = optionalFullBook || booksData.find(b => b.slug === targetKey || b.id === targetKey) || {
            slug: targetKey,
            id: targetKey,
            title: "Saved Book",
            author: "Spidy Hub",
            image: "",
            year: "",
            lang: "English"
        };
        savedBooks.push(bookObj);
        if (iconElement) iconElement.className = "fas fa-bookmark";
        showToast("Added to Bookmarks", "success");
    } else {
        savedBooks.splice(existingIndex, 1);
        if (iconElement) iconElement.className = "far fa-bookmark";
        showToast("Removed from Bookmarks", "info");
    }

    syncAndSanitizeBookmarks();
    if (document.getElementById('bookmarks-panel')?.classList.contains('active')) {
        renderSavedBooksUI();
    }
}

function renderSavedBooksUI() {
    const container = document.getElementById("savedBooksContainer"); 
    const noMsg = document.getElementById("no-saved-msg");
    
    if (!savedBooks || savedBooks.length === 0) { 
        if (container) container.innerHTML = ""; 
        if (noMsg) noMsg.style.display = "flex"; 
        return; 
    }
    if (noMsg) noMsg.style.display = "none"; 

    let htmlChunk = "";
    savedBooks.forEach(item => {
        const book = (typeof item === 'object') ? item : (booksData.find(b => b.slug === item || b.id === item) || {
            slug: item,
            id: item,
            title: item,
            author: "Saved Document",
            image: "",
            year: "",
            lang: "English"
        });

        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `
        <div class="book-card" data-slug="${escapeHTML(book.slug || '')}" data-id="${escapeHTML(book.id || '')}">
            <div class="card-img-wrapper">
                <div class="badge-free">FREE</div>
                <div class="bookmark-btn" data-action="bookmark"><i class="fas fa-bookmark"></i></div>
                <img src="${secureCoverUrl}" loading="lazy" decoding="async" class="book-image" onerror="window.handleBookCoverError(this, '${escapeHTML(secureCoverUrl)}')" oncontextmenu="return false;" draggable="false">
            </div>
            <div class="book-details">
                <div class="book-title">${sanitizeHTML(book.title || '')}</div>
                <div class="book-author">${sanitizeHTML(book.author || '')}</div>
                <div class="tags-container">
                    <span class="book-tag tag-year">${sanitizeHTML(book.year ? book.year.toString() : '')}</span>
                    <span class="book-tag ${langClass}">${sanitizeHTML(book.lang || '')}</span>
                </div>
            </div>
        </div>`;
    });
    if (container) container.innerHTML = htmlChunk;
}

// ==========================================
// 6. PAGINATION & DATA FETCH
// ==========================================
async function loadInitialBooksBatch() {
    try {
        booksData = [];
        lastVisibleBookDoc = null;
        hasMoreBooksToFetch = true;

        const booksRef = collection(db, "books");
        const q = query(booksRef, orderBy("createdAt", "desc"), limit(BATCH_SIZE));
        const snapshot = await getDocs(q);

        snapshot.forEach((docSnap) => {
            let data = docSnap.data();
            data.id = docSnap.id;
            if (!data.slug || data.slug.includes('%')) {
                data.slug = generateCleanSlug(data.title, data.id);
            }
            booksData.push(data);
            if (data.author) allAuthorsCache.add(data.author.trim());
            if (data.year) allYearsCache.add(data.year.toString().trim());
        });

        if (snapshot.docs.length > 0) {
            lastVisibleBookDoc = snapshot.docs[snapshot.docs.length - 1];
            hasMoreBooksToFetch = snapshot.docs.length === BATCH_SIZE;
        } else {
            hasMoreBooksToFetch = false;
        }

        mainFilteredData = [...booksData];
        syncAndSanitizeBookmarks();
        applyMasterFilter();

        isAppReady.data = true;
        tryTransition();
    } catch (e) {
        isAppReady.data = true;
        tryTransition();
    }
}

async function loadNextBooksBatch(isFastFilterFetch = false) {
    if (!hasMoreBooksToFetch || isFetchingBooksBatch || !lastVisibleBookDoc) return;
    isFetchingBooksBatch = true;

    const infiniteLoader = document.getElementById('infinite-loader');
    if (infiniteLoader) {
        infiniteLoader.style.display = 'flex';
        if (!isFastFilterFetch) {
            setTimeout(() => {
                infiniteLoader.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }, 50);
        }
    }

    try {
        if (!isFastFilterFetch) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        const booksRef = collection(db, "books");
        const q = query(booksRef, orderBy("createdAt", "desc"), startAfter(lastVisibleBookDoc), limit(BATCH_SIZE));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            hasMoreBooksToFetch = false;
            if (infiniteLoader) infiniteLoader.style.display = 'none';
            isFetchingBooksBatch = false;
            if (mainFilteredData.length === 0) {
                const noResultsMsg = document.getElementById('no-results-msg');
                if (noResultsMsg) noResultsMsg.style.display = 'flex';
            }
            return;
        }

        const newItems = [];
        snapshot.forEach((docSnap) => {
            let data = docSnap.data();
            data.id = docSnap.id;
            if (!data.slug || data.slug.includes('%')) {
                data.slug = generateCleanSlug(data.title, data.id);
            }
            booksData.push(data);
            newItems.push(data);
            if (data.author) allAuthorsCache.add(data.author.trim());
            if (data.year) allYearsCache.add(data.year.toString().trim());
        });

        lastVisibleBookDoc = snapshot.docs[snapshot.docs.length - 1];
        hasMoreBooksToFetch = snapshot.docs.length === BATCH_SIZE;
        isFetchingBooksBatch = false;

        applyMasterFilter(true, newItems);

    } catch (err) {
        isFetchingBooksBatch = false;
        if (infiniteLoader) infiniteLoader.style.display = 'none';
    } finally {
        if (!hasMoreBooksToFetch && infiniteLoader) {
            infiniteLoader.style.display = 'none';
        }
    }
}

// ==========================================
// 7. PROMO CAROUSEL & MODULE PACKS
// ==========================================
let currentPromoIndex = 0;
let promoAutoSlideInterval = null;

function renderDynamicBanners(banners) {
    const track = document.getElementById('promoCarouselTrack');
    const dotsWrap = document.getElementById('promoDotsWrapper');
    if (!track || !dotsWrap) return;

    if (promoAutoSlideInterval) {
        clearInterval(promoAutoSlideInterval);
        promoAutoSlideInterval = null;
    }

    if (!banners || banners.length === 0) {
        track.innerHTML = `
            <div class="promo-slide">
                <img src="https://i.postimg.cc/Pq0JLj3C/file-0000000027dc82119d3731d4bfe9bccf.png" alt="Promo Banner" class="promo-banner-img" draggable="false">
            </div>`;
        dotsWrap.innerHTML = `<span class="promo-dot active" data-slide="0"></span>`;
        return;
    }

    let slidesHTML = "";
    let dotsHTML = "";

    banners.forEach((banner, idx) => {
        const imageUrl = getSecureAssetUrl(banner.bannerImage);
        slidesHTML += `
            <div class="promo-slide" data-banner-id="${escapeHTML(banner.id)}" onclick="window.openBannerModules('${escapeHTML(banner.id)}')">
                <img src="${imageUrl}" alt="${escapeHTML(banner.title || 'Module Banner')}" class="promo-banner-img" draggable="false" onerror="this.src='https://i.postimg.cc/Pq0JLj3C/file-0000000027dc82119d3731d4bfe9bccf.png'">
            </div>`;
        dotsHTML += `<span class="promo-dot ${idx === 0 ? 'active' : ''}" data-slide="${idx}"></span>`;
    });

    track.innerHTML = slidesHTML;
    dotsWrap.innerHTML = dotsHTML;
    currentPromoIndex = 0;
    initPromoCarousel();
}

function initPromoCarousel() {
    const track = document.getElementById('promoCarouselTrack');
    const dots = document.querySelectorAll('.promo-dot');
    const totalSlides = dots.length;

    if (!track || totalSlides === 0) return;
    if (promoAutoSlideInterval) clearInterval(promoAutoSlideInterval);

    function goToSlide(index) {
        currentPromoIndex = (index + totalSlides) % totalSlides;
        track.style.transform = `translateX(-${currentPromoIndex * 100}%)`;
        dots.forEach((dot, idx) => {
            dot.classList.toggle('active', idx === currentPromoIndex);
        });
    }

    function startAutoSlide() {
        clearInterval(promoAutoSlideInterval);
        if (totalSlides > 1) {
            promoAutoSlideInterval = setInterval(() => {
                goToSlide(currentPromoIndex + 1);
            }, 4000);
        }
    }

    dots.forEach((dot, index) => {
        dot.onclick = (e) => {
            e.stopPropagation();
            goToSlide(index);
            startAutoSlide();
        };
    });

    const pBtn = document.getElementById('promoPrevBtn');
    const nBtn = document.getElementById('promoNextBtn');

    if (pBtn) {
        pBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            goToSlide(currentPromoIndex - 1);
            startAutoSlide();
        };
    }

    if (nBtn) {
        nBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            goToSlide(currentPromoIndex + 1);
            startAutoSlide();
        };
    }

    if (!track.dataset.touchBound) {
        track.dataset.touchBound = "true";
        let startX = 0;
        track.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            clearInterval(promoAutoSlideInterval);
        }, { passive: true });

        track.addEventListener('touchend', (e) => {
            const diffX = startX - e.changedTouches[0].clientX;
            if (Math.abs(diffX) > 40) {
                if (diffX > 0) goToSlide(currentPromoIndex + 1);
                else goToSlide(currentPromoIndex - 1);
            }
            startAutoSlide();
        }, { passive: true });
    }

    goToSlide(currentPromoIndex);
    startAutoSlide();
}

window.openBannerModules = function(bannerId) {
    if (!isUserLoggedIn || !auth.currentUser) {
        triggerLoginModal();
        return;
    }

    const banner = dynamicBannersList.find(b => b.id === bannerId);
    if (!banner) return;
    activeBannerData = banner;
    activeSubjectKey = null;

    const titleEl = document.getElementById('moduleHeaderTitle');
    if (titleEl) titleEl.innerText = (banner.title || "MODULE PACK").toUpperCase();
    
    document.getElementById('bannerSubjectsView').classList.remove('hidden-view');
    document.getElementById('bannerModulesView').classList.add('hidden-view');

    const container = document.getElementById('subjectCardsList');
    if (!container) return;

    const subjectsConfig = [
        { key: 'physics', name: 'Physics', iconClass: 'icon-physics', iconHtml: '<i class="fas fa-atom"></i>' },
        { key: 'chemistry', name: 'Chemistry', iconClass: 'icon-chemistry', iconHtml: '<i class="fas fa-flask"></i>' },
        { key: 'botany', name: 'Botany', iconClass: 'icon-botany', iconHtml: '<i class="fas fa-seedling"></i>' },
        { key: 'zoology', name: 'Zoology', iconClass: 'icon-zoology', iconHtml: '<i class="fas fa-dna"></i>' },
        { key: 'mathematics', name: 'Mathematics', iconClass: 'icon-maths', iconHtml: '<i class="fas fa-square-root-variable"></i>' }
    ];

    let html = "";
    const subjectsData = banner.subjectsData || {};

    subjectsConfig.forEach(sub => {
        const modulesArr = subjectsData[sub.key] || [];
        if (modulesArr.length > 0) {
            html += `
            <div class="subject-pod-card" onclick="window.openSubjectModulesList('${sub.key}')">
                <div class="subject-icon-wrap ${sub.iconClass}">${sub.iconHtml}</div>
                <div class="subject-meta-text">
                    <div class="subject-name-main">${sub.name}</div>
                    <div class="subject-modules-count">${modulesArr.length} Modules Available</div>
                </div>
                <div class="pod-round-arrow-wrap"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg></div>
            </div>`;
        }
    });

    if (html === "") {
        html = `<div style="text-align:center; padding:35px 20px; color:#a1a1aa; font-weight:700;">No modules uploaded yet.</div>`;
    }

    container.innerHTML = html;
    const modal = document.getElementById('moduleBannerModal');
    if (modal) {
        toggleBackgroundFreeze(true);
        safePushHistory({ popup: 'moduleBanner' });
        modal.classList.add('active');
    }
};

window.openSubjectModulesList = function(subjectKey) {
    if (!isUserLoggedIn || !auth.currentUser) {
        triggerLoginModal();
        return;
    }
    if (!activeBannerData) return;
    activeSubjectKey = subjectKey;

    const subjectDisplayNames = {
        physics: "Physics Modules",
        chemistry: "Chemistry Modules",
        botany: "Botany Modules",
        zoology: "Zoology Modules",
        mathematics: "Mathematics Modules"
    };

    const modules = (activeBannerData.subjectsData && activeBannerData.subjectsData[subjectKey]) || [];
    document.getElementById('moduleSubjectSubheading').innerText = subjectDisplayNames[subjectKey] || "Modules";
    document.getElementById('moduleCountTextBadge').innerText = `${modules.length} Modules`;

    const container = document.getElementById('moduleCardsContainer');
    if (!container) return;

    if (modules.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:35px 20px; color:#a1a1aa;">No modules found.</div>`;
    } else {
        let html = "";
        modules.forEach((mod, modIdx) => {
            const rawPdfUrl = mod.pdfLink || "";
            const safeEncodedKey = encodeURIComponent(rawPdfUrl);
            const rawModTitle = mod.name || `Module ${modIdx + 1}`;
            const encodedTitle = encodeURIComponent(rawModTitle);
            let pageLabel = mod.pages ? (mod.pages.includes("Page") ? mod.pages : `${mod.pages} Pages`) : "Complete Document";

            html += `
            <div class="module-pdf-card" onclick="window.readModulePdfDirectly(decodeURIComponent('${safeEncodedKey}'), decodeURIComponent('${encodedTitle}'))">
                <div class="module-svg-icon-wrap">
                    <svg viewBox="0 0 64 64" fill="none" width="44" height="44">
                        <path d="M16 8C14.9 8 14 8.9 14 10V54C14 55.1 14.9 56 16 56H48C49.1 56 50 55.1 50 54V22L36 8H16Z" fill="#dc2626"/>
                        <path d="M36 8V22H50L36 8Z" fill="#f87171"/>
                        <line x1="22" y1="28" x2="42" y2="28" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
                        <line x1="22" y1="34" x2="34" y2="34" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
                        <rect x="20" y="40" width="24" height="9" rx="3" fill="#ffffff"/>
                        <text x="32" y="47" font-family="sans-serif" font-size="6.8" font-weight="800" fill="#dc2626" text-anchor="middle">PDF</text>
                    </svg>
                </div>
                <div class="module-details-wrap">
                    <div class="module-title-h3">${escapeHTML(rawModTitle)}</div>
                    <span class="module-tag-pages"><i class="fas fa-layer-group"></i> ${escapeHTML(pageLabel)}</span>
                </div>
                <div class="pod-round-arrow-wrap"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg></div>
            </div>`;
        });
        container.innerHTML = html;
    }

    safePushHistory({ popup: 'moduleList', subjectKey: subjectKey });
    document.getElementById('bannerSubjectsView').classList.add('hidden-view');
    document.getElementById('bannerModulesView').classList.remove('hidden-view');
};

// ==========================================
// READ MODULE PDF DIRECTLY (CLOUDFLARE WORKER)
// ==========================================
window.readModulePdfDirectly = async function(pdfKeyOrUrl, title) {
    if (!isUserLoggedIn || !auth.currentUser) {
        triggerLoginModal();
        return;
    }

    if (isRequestingPdf) return;
    isRequestingPdf = true;

    const savedData = localStorage.getItem('spidy_secure_session');
    let hasValidToken = false;
    let clientToken = "";
    const currentFp = generateDeviceFingerprint(auth.currentUser?.uid);

    if (savedData) {
        try {
            const parsed = JSON.parse(savedData);
            if (parsed.fp === currentFp && parsed.expiry > Date.now()) {
                hasValidToken = true;
                clientToken = parsed.token || "";
            }
        } catch(e) {}
    }

    if (!hasValidToken && !IS_SUPER_ADMIN) {
        isRequestingPdf = false;
        safePushHistory({ popup: 'tokenModal', returnTo: 'module' });
        const tModal = document.getElementById('tokenModalOverlay');
        if (tModal) tModal.style.display = 'flex';
        return;
    }

    const pdfViewer = document.getElementById('pdfViewerOverlay');
    const titleEl = document.getElementById('pdfViewerTitle');

    if (titleEl) titleEl.innerText = title || "Reading Module...";
    if (pdfViewer) {
        safePushHistory({ popup: 'pdfViewer', from: 'module' });
        pdfViewer.style.display = 'flex';
    }

    showCenteredPdfLoader("Just a Moment… Your Module Is Almost Ready..!! 🚀📚");
    const distinctModuleSlug = generateCleanSlug(title || pdfKeyOrUrl || "module-pack");

    if (!pdfKeyOrUrl || pdfKeyOrUrl.trim() === "") {
        showToast("Invalid module document link", "error");
        if (pdfViewer) pdfViewer.style.display = 'none';
        isRequestingPdf = false;
        return;
    }

    try {
        const userToken = await auth.currentUser.getIdToken(false);
        const response = await fetch(`${SPIDY_API_WORKER_URL}/api/get-book`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                pdfKey: pdfKeyOrUrl,
                bookSlug: distinctModuleSlug,
                docType: "module",
                userToken: userToken,
                token: clientToken,
                fingerprint: currentFp
            })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            renderPdfInModal(data.pdfLink, true, "module", distinctModuleSlug);
        } else {
            if (pdfViewer) pdfViewer.style.display = 'none';
            cleanupPdfResources();
            showToast(data.error || "Access denied. Key required.", "error");

            if (data.requireToken) {
                localStorage.removeItem('spidy_secure_session');
                safePushHistory({ popup: 'tokenModal', returnTo: 'module' });
                const tModal = document.getElementById('tokenModalOverlay');
                if (tModal) tModal.style.display = 'flex';
            }
        }
    } catch (err) {
        if (pdfViewer) pdfViewer.style.display = 'none';
        cleanupPdfResources();
        showToast("Failed to load module. Please try again.", "error");
    } finally {
        isRequestingPdf = false;
    }
};

// ==========================================
// 8. BOOK DETAIL & READ ONLINE
// ==========================================
async function openDownloadPageLocal(slugOrId, skipPushState = false) {
    if (!isUserLoggedIn) {
        triggerLoginModal();
        return;
    }

    let book = booksData.find(b => b.slug === slugOrId || b.id === slugOrId); 

    if (!book) {
        showCenteredPdfLoader("Fetching book details...");
        try {
            let docRef = doc(db, "books", slugOrId);
            let docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                book = docSnap.data();
                book.id = docSnap.id;
            } else {
                const q = query(collection(db, "books"), where("slug", "==", slugOrId), limit(1));
                const qSnap = await getDocs(q);
                if (!qSnap.empty) {
                    book = qSnap.docs[0].data();
                    book.id = qSnap.docs[0].id;
                }
            }
            if (book) {
                if (!book.slug) book.slug = generateCleanSlug(book.title, book.id);
                booksData.push(book);
            }
        } catch (e) {}
    }

    const loaderScreen = document.getElementById("loaderScreen");
    if (loaderScreen && loaderScreen.style.display !== 'none') {
        loaderScreen.style.display = 'none';
    }

    if (!book) {
        showToast("Book not found or link has expired", "error");
        return;
    }
    
    const downloadModal = document.getElementById("downloadModal");
    if (downloadModal) {
        toggleBackgroundFreeze(true);
        downloadModal.style.display = "flex";

        requestAnimationFrame(() => {
            downloadModal.scrollTop = 0;
            const innerContent = downloadModal.querySelector('.dl-content-wrapper') || downloadModal.firstElementChild;
            if (innerContent) innerContent.scrollTop = 0;
        });
    }
    
    const previewImg = document.getElementById("dlPreviewImage");
    if (previewImg) {
        const fullCoverUrl = getSecureAssetUrl(book.image);
        previewImg.src = fullCoverUrl; 
        previewImg.onerror = () => { window.handleBookCoverError(previewImg, fullCoverUrl); };
    }

    document.getElementById("dlBookTitle").textContent = book.title || ""; 
    document.getElementById("dlBookAuthor").textContent = book.author || "";

    const fileSizeSub = document.getElementById('dlFileSize');
    if (fileSizeSub) {
        const formatText = book.fileFormat || "PDF";
        const sizeText = book.fileSize ? `${book.fileSize} • ` : "";
        fileSizeSub.innerText = `${sizeText}${formatText} Document`;
    }

    const totalPagesSub = document.getElementById('dlTotalPages');
    if (totalPagesSub) {
        const pNum = parseInt(book.totalPages, 10);
        totalPagesSub.innerText = (!isNaN(pNum) && pNum > 0) ? `${pNum} Pages Included` : `${book.totalPages || "Complete Book"} Included`;
    }

    const readBtn = document.getElementById("dlReadOnlineBtn");
    if (readBtn) {
        readBtn.onclick = async function() {
            if (!isUserLoggedIn || !auth.currentUser) { 
                triggerLoginModal();
                return; 
            }
            if (isRequestingPdf) return;
            isRequestingPdf = true;
            
            const originalText = readBtn.innerHTML; 

            const savedData = localStorage.getItem('spidy_secure_session');
            let hasValidToken = false;
            let clientToken = "";
            const currentFp = generateDeviceFingerprint(auth.currentUser?.uid);

            if (savedData) {
                try {
                    const parsed = JSON.parse(savedData);
                    if (parsed.fp === currentFp && parsed.expiry > Date.now()) {
                        hasValidToken = true;
                        clientToken = parsed.token || "";
                    }
                } catch(e) {}
            }

            if (!hasValidToken && !IS_SUPER_ADMIN) {
                isRequestingPdf = false;
                safePushHistory({ popup: 'tokenModal', returnTo: 'book' });
                const tModal = document.getElementById('tokenModalOverlay');
                if (tModal) tModal.style.display = 'flex';
                return; 
            }
            
            readBtn.innerHTML = `<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Ready..`; 
            readBtn.disabled = true;

            try {
                const userToken = await auth.currentUser.getIdToken(false);
                const response = await fetch(`${SPIDY_API_WORKER_URL}/api/get-book`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        bookId: book.id, 
                        bookSlug: book.slug || book.id,
                        docType: "book",
                        userToken: userToken,
                        token: clientToken,
                        fingerprint: currentFp
                    })
                });

                const data = await response.json();
                if (response.ok && data.success) {
                    const pdfViewer = document.getElementById('pdfViewerOverlay');
                    const title = document.getElementById('pdfViewerTitle');
                    if (title) title.innerText = book.title || "";
                    safePushHistory({ popup: 'pdfViewer', from: 'book' });
                    if (pdfViewer) pdfViewer.style.display = 'flex';
                    renderPdfInModal(data.pdfLink, false, "book", book.slug || book.id);
                } else {
                    showToast(data.error || "Access denied", "error");
                    if (data.requireToken) {
                        localStorage.removeItem('spidy_secure_session');
                        safePushHistory({ popup: 'tokenModal', returnTo: 'book' });
                        const tModal = document.getElementById('tokenModalOverlay');
                        if (tModal) tModal.style.display = 'flex';
                    }
                }
            } catch (error) { 
                showToast("Failed to load book", "error"); 
            } finally {
                readBtn.innerHTML = originalText; 
                readBtn.disabled = false; 
                isRequestingPdf = false;
            }
        };
    }

    let examsArray = (book.exams || "General").split(',').map(item => sanitizeHTML(item.trim()));
    document.getElementById("dlModalTags").innerHTML = examsArray.map(exam => `<div class="dl-modal-tag">${exam}</div>`).join('');
    
    activeBookSlug = book.slug || book.id; 
    activeBookId = book.id;
    activeBookTitle = book.title; 
    
    if (!skipPushState) { 
        safePushHistory({ popup: 'book' }, '?book=' + (book.slug || book.id)); 
    }
}

function closeDownloadPageLocal() {
    clearActiveElementFocus();
    toggleBackgroundFreeze(false);
    if (history.state && history.state.popup === 'book') { 
        history.back(); 
    } else { 
        document.getElementById("downloadModal").style.display = "none"; 
        window.history.replaceState({}, '', window.location.pathname); 
    }
}

// ==========================================
// 9. EVENT LISTENERS & POPSTATE ENGINE
// ==========================================
function initAppListeners() {
    loadInitialBooksBatch();
    fetchGlobalFilterMetadata();
    initChannelEngine();

    initAuthSystem(() => {
        if (isDeepLinkLoad && pendingBookSlug) {
            document.getElementById('mainAppWrapper').style.display = 'block';
            setTimeout(() => openDownloadPageLocal(pendingBookSlug, true), 300);
        } else if (pendingTargetPostId) {
            document.getElementById('mainAppWrapper').style.display = 'block';
            setTimeout(checkAndOpenTargetPost, 350);
        }
    });

    initFiltersEngine(() => booksData, () => applyMasterFilter(false));
    initPdfViewerUI();
    initUploadPipeline(() => IS_SUPER_ADMIN, (newBook) => {
        booksData.unshift(newBook);
        allAuthorsCache.add(newBook.author);
        allYearsCache.add(newBook.year);
        applyMasterFilter(false);
    });

    // 300ms Debounced Search
    const searchInput = document.getElementById('app-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                applyMasterFilter(false);
            }, 300);
        });
    }

    document.getElementById('open-search')?.addEventListener('click', () => { 
        clearActiveElementFocus();
        safePushHistory({ popup: 'search' }); 
        document.getElementById('search-box')?.classList.add('active'); 
        setTimeout(() => { document.getElementById('app-search-input')?.focus(); }, 300); 
    });

    document.getElementById('open-noti')?.addEventListener('click', () => { 
        clearActiveElementFocus();
        if (!isUserLoggedIn || !auth.currentUser) {
            triggerLoginModal();
            return;
        }

        toggleBackgroundFreeze(true);
        safePushHistory({ popup: 'noti' }); 
        document.getElementById('noti-panel')?.classList.add('active'); 
        
        const blinkDot = document.querySelector('.blink-dot');
        if (blinkDot) blinkDot.style.display = 'none'; 

        if (livePosts && livePosts.length > 0) {
            renderChannelFeed(livePosts, true);
        } else {
            renderChannelLoader();
        }
    });

    document.getElementById('close-noti-btn')?.addEventListener('click', () => {
        clearActiveElementFocus();
        toggleBackgroundFreeze(false);
        if (history.state && history.state.popup === 'noti') {
            history.back();
        } else {
            document.getElementById('noti-panel')?.classList.remove('active');
        }
        if (window.location.hash.includes('post/')) {
            history.replaceState(null, '', window.location.pathname);
        }
    });

    document.getElementById('open-upload-btn')?.addEventListener('click', () => {
        clearActiveElementFocus();
        if (!isUserLoggedIn || !auth.currentUser) {
            triggerLoginModal();
            return;
        }

        const uploadModal = document.getElementById('uploadModalOverlay');
        if (uploadModal) {
            toggleBackgroundFreeze(true);
            safePushHistory({ popup: 'uploadModal' });
            uploadModal.classList.add('active');
        }
    });

    document.getElementById('closeUploadHubBtn')?.addEventListener('click', () => {
        clearActiveElementFocus();
        toggleBackgroundFreeze(false);
        if (history.state && history.state.popup === 'uploadModal') {
            history.back();
        } else {
            document.getElementById('uploadModalOverlay')?.classList.remove('active');
        }
    });

    document.getElementById('reportLinkBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearActiveElementFocus();
        const reportModal = document.getElementById('reportModalOverlay');
        if (reportModal) {
            safePushHistory({ popup: 'reportModal' });
            reportModal.classList.add('active');
        }
    });

    document.getElementById('closeReportBtn')?.addEventListener('click', () => {
        clearActiveElementFocus();
        if (history.state && history.state.popup === 'reportModal') {
            history.back();
        } else {
            document.getElementById('reportModalOverlay')?.classList.remove('active');
        }
    });

    document.getElementById('reportModalOverlay')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('reportModalOverlay')) {
            clearActiveElementFocus();
            if (history.state && history.state.popup === 'reportModal') history.back();
            else document.getElementById('reportModalOverlay')?.classList.remove('active');
        }
    });

    const reportOptions = document.querySelectorAll('.rm-option');
    const submitReportBtn = document.getElementById('submitReportBtn');

    reportOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            reportOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            if (submitReportBtn) submitReportBtn.classList.add('enabled');
        });
    });

    submitReportBtn?.addEventListener('click', async () => {
        if (isSubmittingReport) return;
        const selectedOption = document.querySelector('.rm-option.selected');
        if (!selectedOption) return;

        isSubmittingReport = true;
        submitReportBtn.disabled = true;
        const originalText = submitReportBtn.innerHTML;
        submitReportBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Submitting...`;

        const issueType = selectedOption.querySelector('span')?.innerText || "General Issue";
        try {
            await addDoc(collection(db, "reports"), {
                bookTitle: activeBookTitle || "Unknown",
                bookSlug: activeBookSlug || "Unknown",
                issueType: issueType,
                status: 'Pending',
                reportedBy: (auth.currentUser && auth.currentUser.email) ? auth.currentUser.email : 'Unknown User',
                createdAt: serverTimestamp()
            });

            submitReportBtn.innerHTML = '<i class="fas fa-check-circle"></i> Successfully Reported';
            submitReportBtn.style.background = '#10b981';
            
            setTimeout(() => {
                clearActiveElementFocus();
                if (history.state && history.state.popup === 'reportModal') history.back();
                else document.getElementById('reportModalOverlay')?.classList.remove('active');
                
                setTimeout(() => {
                    submitReportBtn.innerHTML = originalText;
                    submitReportBtn.style.background = '';
                    submitReportBtn.classList.remove('enabled');
                    submitReportBtn.disabled = false;
                    reportOptions.forEach(o => o.classList.remove('selected'));
                    isSubmittingReport = false;
                }, 400);
            }, 1200);
        } catch (error) {
            showToast("Failed to submit report. Please try again.", "error");
            submitReportBtn.innerHTML = originalText;
            submitReportBtn.disabled = false;
            isSubmittingReport = false;
        }
    });

    const sentinel = document.getElementById('scroll-sentinel');
    if (sentinel) {
        const infiniteScrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && hasMoreBooksToFetch && !isFetchingBooksBatch) {
                    loadNextBooksBatch(false);
                }
            });
        }, { root: document.getElementById('mainContentArea'), rootMargin: '0px 0px 150px 0px', threshold: 0.1 });
        infiniteScrollObserver.observe(sentinel);
    }

    document.getElementById('bookContainer')?.addEventListener('click', (e) => {
        const card = e.target.closest('.book-card');
        if (card) {
            const slug = card.getAttribute('data-slug') || card.getAttribute('data-id');
            const bookmarkBtn = e.target.closest('.bookmark-btn');
            if (bookmarkBtn) {
                toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug);
            } else {
                openDownloadPageLocal(slug);
            }
        }
    });

    document.getElementById('savedBooksContainer')?.addEventListener('click', (e) => {
        const card = e.target.closest('.book-card');
        if (card) {
            const slug = card.getAttribute('data-slug') || card.getAttribute('data-id');
            const bookmarkBtn = e.target.closest('.bookmark-btn');
            if (bookmarkBtn) {
                toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug);
            } else {
                openDownloadPageLocal(slug);
            }
        }
    });

    document.getElementById('closeDlBtn')?.addEventListener('click', closeDownloadPageLocal);
    document.getElementById('shareBookBtn')?.addEventListener('click', () => {
        const shareUrl = window.location.origin + window.location.pathname + "?book=" + activeBookSlug;
        if (navigator.share) {
            navigator.share({ title: activeBookTitle, text: "Read this book online", url: shareUrl });
        } else { 
            navigator.clipboard.writeText(shareUrl); 
            showToast("Link Copied!", "success"); 
        }
    });

    const sidebar = document.getElementById('sidebar'); 
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    document.getElementById('open-menu')?.addEventListener('click', () => { 
        clearActiveElementFocus();
        toggleBackgroundFreeze(true);
        safePushHistory({ popup: 'sidebar' }); 
        sidebar?.classList.add('active'); 
        sidebarOverlay?.classList.add('active'); 
    });

    sidebarOverlay?.addEventListener('click', () => history.back());

    document.getElementById('menu-home-side')?.addEventListener('click', (e) => {
        e.preventDefault();
        clearActiveElementFocus();
        toggleBackgroundFreeze(false);
        if (history.state && history.state.popup === 'sidebar') {
            history.back();
        } else {
            sidebar?.classList.remove('active');
            sidebarOverlay?.classList.remove('active');
        }
        document.getElementById('mainContentArea')?.scrollTo({ top: 0, behavior: 'smooth' });
    });

    document.getElementById('menu-bookmarks')?.addEventListener('click', (e) => { 
        e.preventDefault(); 
        clearActiveElementFocus();
        toggleBackgroundFreeze(true);
        safePushHistory({ popup: 'bookmarks' }); 
        document.getElementById('bookmarks-panel')?.classList.add('active'); 
        sidebar?.classList.remove('active'); 
        sidebarOverlay?.classList.remove('active'); 
        renderSavedBooksUI(); 
    });
    
    document.getElementById('close-bookmarks-btn')?.addEventListener('click', () => history.back());

    // Native Popstate Engine
    window.addEventListener('popstate', (e) => {
        clearActiveElementFocus();

        const goToPageModal = document.getElementById('goToPageModal');
        if (goToPageModal && goToPageModal.style.display === 'flex') {
            goToPageModal.style.display = 'none';
            return;
        }

        const channelContext = document.getElementById('contextOverlay');
        if (channelContext && channelContext.classList.contains('show')) {
            channelContext.classList.remove('show');
            return;
        }

        const loginOverlay = document.getElementById('loginOverlay');
        if (loginOverlay && (loginOverlay.style.display === 'flex' || loginOverlay.style.opacity === '1')) {
            loginOverlay.style.opacity = '0';
            setTimeout(() => { loginOverlay.style.display = 'none'; }, 350);
            return;
        }

        const tokenModal = document.getElementById('tokenModalOverlay');
        if (tokenModal && tokenModal.style.display === 'flex') {
            tokenModal.style.display = 'none';
            return;
        }

        const pdfViewer = document.getElementById('pdfViewerOverlay');
        if (pdfViewer && pdfViewer.style.display === 'flex') {
            pdfViewer.style.display = 'none';
            const scroller = document.getElementById('pdfScrollContainer');
            if (scroller) scroller.innerHTML = '';
            cleanupPdfResources();
            return; 
        }

        const reportModal = document.getElementById('reportModalOverlay');
        if (reportModal && reportModal.classList.contains('active')) {
            reportModal.classList.remove('active');
            return;
        }

        const subFilterModal = document.getElementById('subFilterModalOverlay');
        if (subFilterModal && subFilterModal.classList.contains('active')) {
            closeSubFilterModal();
            return;
        }

        const mainFilterModal = document.getElementById('mainFilterOverlay');
        if (mainFilterModal && mainFilterModal.classList.contains('active')) {
            closeMainFilterModal();
            return;
        }

        const uploadModal = document.getElementById('uploadModalOverlay');
        if (uploadModal && uploadModal.classList.contains('active')) {
            uploadModal.classList.remove('active');
            toggleBackgroundFreeze(false);
            return;
        }

        const bannerModal = document.getElementById('moduleBannerModal');
        if (bannerModal && bannerModal.classList.contains('active')) {
            const modulesView = document.getElementById('bannerModulesView');
            const subjectsView = document.getElementById('bannerSubjectsView');
            if (modulesView && !modulesView.classList.contains('hidden-view')) {
                modulesView.classList.add('hidden-view');
                subjectsView?.classList.remove('hidden-view');
                const titleEl = document.getElementById('moduleHeaderTitle');
                if (titleEl) titleEl.innerText = (activeBannerData?.title || "MODULE PACK").toUpperCase();
                activeSubjectKey = null;
                return;
            }
            bannerModal.classList.remove('active');
            activeBannerData = null;
            activeSubjectKey = null;
            toggleBackgroundFreeze(false);
            return;
        }

        const downloadModal = document.getElementById("downloadModal");
        if (downloadModal && downloadModal.style.display === "flex") {
            downloadModal.style.display = "none";
            toggleBackgroundFreeze(false);
            window.history.replaceState({}, '', window.location.pathname);
            return;
        }

        const notiPanel = document.getElementById('noti-panel');
        if (notiPanel && notiPanel.classList.contains('active')) {
            notiPanel.classList.remove('active');
            toggleBackgroundFreeze(false);
            if (window.location.hash.includes('post/')) {
                history.replaceState(null, '', window.location.pathname);
            }
            return;
        }

        const sidebar = document.getElementById('sidebar');
        if (sidebar && sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
            document.getElementById('sidebar-overlay')?.classList.remove('active');
            toggleBackgroundFreeze(false);
            return;
        }

        const bookmarksPanel = document.getElementById('bookmarks-panel');
        if (bookmarksPanel && bookmarksPanel.classList.contains('active')) {
            bookmarksPanel.classList.remove('active');
            toggleBackgroundFreeze(false);
            return;
        }

        const searchBox = document.getElementById('search-box');
        if (searchBox && searchBox.classList.contains('active')) {
            searchBox.classList.remove('active');
            return;
        }
    });

    document.getElementById('moduleBackBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearActiveElementFocus();
        const modulesView = document.getElementById('bannerModulesView');
        if (modulesView && !modulesView.classList.contains('hidden-view')) {
            if (history.state && history.state.popup === 'moduleList') {
                history.back();
            } else {
                modulesView.classList.add('hidden-view');
                document.getElementById('bannerSubjectsView')?.classList.remove('hidden-view');
                document.getElementById('moduleHeaderTitle').innerText = (activeBannerData?.title || "MODULE PACK").toUpperCase();
            }
        } else {
            if (history.state && history.state.popup === 'moduleBanner') {
                history.back();
            } else {
                document.getElementById('moduleBannerModal')?.classList.remove('active');
                activeBannerData = null;
                toggleBackgroundFreeze(false);
            }
        }
    });

    document.getElementById("closePdfViewerBtn")?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearActiveElementFocus();
        if (history.state && history.state.popup === 'pdfViewer') {
            history.back();
        } else {
            const pdfViewer = document.getElementById('pdfViewerOverlay');
            if (pdfViewer) pdfViewer.style.display = 'none';
            document.getElementById('pdfScrollContainer').innerHTML = ''; 
            cleanupPdfResources();
        }
    });
}

// Check Document Ready State
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAppListeners);
} else {
    initAppListeners();
}

// ==========================================
// 10. AUTH STATE & LIVE SYNC PIPELINE
// ==========================================
onAuthStateChanged(auth, async (user) => {
    if (user) {
        isUserLoggedIn = true;
        localStorage.setItem('isUserLoggedIn', 'true');

        let dName = user.displayName || (user.email ? user.email.split('@')[0] : "User");
        const profileEl = document.getElementById('sidebarProfileName');
        if (profileEl) profileEl.textContent = dName;
        
        CURRENT_ADMIN_PHOTO = getHighQualityAvatar(user.photoURL);
        const sidebarAvatar = document.getElementById('sidebarProfileImg');
        if (sidebarAvatar) {
            sidebarAvatar.src = CURRENT_ADMIN_PHOTO;
            sidebarAvatar.onerror = () => { sidebarAvatar.src = DEFAULT_AVATAR; };
        }
        
        CURRENT_ADMIN_NAME = dName;
        CURRENT_ADMIN_EMAIL = user.email || "";

        try {
            const cleanEmail = user.email ? user.email.toLowerCase().trim() : "";
            const adminDocRef = doc(db, "admins", cleanEmail);
            const adminDocSnap = await getDoc(adminDocRef);
            IS_SUPER_ADMIN = adminDocSnap.exists();
            const roleEl = document.getElementById('sidebarRoleText');
            if (roleEl) roleEl.innerText = IS_SUPER_ADMIN ? "Super Admin" : "Verified User";
        } catch (error) { 
            IS_SUPER_ADMIN = false; 
        }

        if (hasTransitioned) {
            if (pendingTargetPostId) {
                checkAndOpenTargetPost();
            } else if (isDeepLinkLoad && pendingBookSlug) {
                openDownloadPageLocal(pendingBookSlug, true);
            }
        }
    } else {
        isUserLoggedIn = false; 
        IS_SUPER_ADMIN = false; 
        localStorage.removeItem('isUserLoggedIn');
        const profileEl = document.getElementById('sidebarProfileName');
        if (profileEl) profileEl.innerText = "SPIDY BOOK HUB";
        const roleEl = document.getElementById('sidebarRoleText');
        if (roleEl) roleEl.innerText = "Please Login";
        
        CURRENT_ADMIN_PHOTO = DEFAULT_AVATAR;
        const sidebarAvatar = document.getElementById('sidebarProfileImg');
        if (sidebarAvatar) sidebarAvatar.src = DEFAULT_AVATAR;
    }

    isAppReady.auth = true; 
    tryTransition();

    if (hasRealtimeListenersBound) return;
    hasRealtimeListenersBound = true;

    // Module Banners Realtime Sync
    onSnapshot(query(collection(db, "module_banners"), orderBy("createdAt", "desc")), (snapshot) => {
        dynamicBannersList = [];
        snapshot.forEach(docSnap => {
            let b = docSnap.data();
            b.id = docSnap.id;
            dynamicBannersList.push(b);
        });
        renderDynamicBanners(dynamicBannersList);
    });
});
