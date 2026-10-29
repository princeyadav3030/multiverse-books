// File: app.js

import { 
    auth, db, collection, addDoc, doc, getDoc, getDocs, 
    query, orderBy, limit, startAfter, serverTimestamp, onAuthStateChanged, onSnapshot 
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

// Safe parse & auto-clean any corrupted bookmark entries
let savedBooks = [];
try {
    const rawSaved = JSON.parse(localStorage.getItem('spidy_saved_books'));
    if (Array.isArray(rawSaved)) {
        savedBooks = rawSaved
            .map(item => (typeof item === 'object' && item !== null) ? (item.slug || item.id) : item)
            .filter( item => typeof item === 'string' && item.trim().length > 0);
    }
} catch (e) {
    savedBooks = [];
}

let dynamicBannersList = [];
let activeBannerData = null;
let activeSubjectKey = null;

let isAppReady = { auth: false, data: false }; 
let hasTransitioned = false;
let isTransitioning = false;
let loadingProgress = 1;
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

// Community Popup Controls & Verified SVG
let hasClickedWA = false;
let hasClickedTG = false;
let hasClickedIG = false;
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

// Helper: Safe History Push (Prevents duplicate states on rapid taps)
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

// ==========================================
// 2. LOADER & TRANSITION ENGINE
// ==========================================
function updateLoaderUI(percent) {
    const loaderFill = document.getElementById('loaderFill');
    const loaderPercentage = document.getElementById('loaderPercentage');
    const loaderStatusText = document.getElementById('loaderStatusText');
    if (loaderFill) loaderFill.style.width = percent + "%";
    if (loaderPercentage) loaderPercentage.innerText = Math.floor(percent) + "%";
    if (loaderStatusText) {
        if (percent < 30) loaderStatusText.innerText = "Initializing System...";
        else if (percent < 65) loaderStatusText.innerText = "Loading Books Securely...";
        else if (percent < 96) loaderStatusText.innerText = "Preparing Content...";
        else loaderStatusText.innerText = "Ready to Launch!";
    }
}

function runSmoothLoaderTick() {
    if (hasTransitioned || isTransitioning) return;

    if (loadingProgress < 65) {
        loadingProgress += 1.2;
    } else if (loadingProgress < 85) {
        loadingProgress += 0.9;
    } else if (loadingProgress < 95) {
        loadingProgress += isAppReady.data ? 1.2 : 0.3;
    }

    if (loadingProgress > 95 && !isAppReady.data) {
        loadingProgress = 95;
    }

    updateLoaderUI(Math.min(95, loadingProgress));

    if (isAppReady.data && isAppReady.auth) {
        tryTransition();
    } else {
        const nextDelay = loadingProgress > 80 ? (isAppReady.data ? 20 : 140) : 35;
        loaderInterval = setTimeout(runSmoothLoaderTick, nextDelay);
    }
}

updateLoaderUI(1);
loaderInterval = setTimeout(runSmoothLoaderTick, 35);

// Hard Fallback: Never let loader stay stuck beyond 6 seconds
setTimeout(() => {
    if (!hasTransitioned) {
        isAppReady.auth = true;
        isAppReady.data = true;
        tryTransition();
    }
}, 6000);

function tryTransition() {
    if (isAppReady.auth && isAppReady.data && !hasTransitioned && !isTransitioning) {
        isTransitioning = true;
        clearTimeout(loaderInterval);

        let finishStep = setInterval(() => {
            loadingProgress += 2.5;
            if (loadingProgress >= 100) {
                loadingProgress = 100;
                updateLoaderUI(100);
                clearInterval(finishStep);
                hasTransitioned = true;
                isTransitioning = false;

                setTimeout(() => {
                    const mainApp = document.getElementById('mainAppWrapper');
                    if (mainApp) mainApp.style.display = 'block';

                    const loader = document.getElementById("loaderScreen");
                    if (loader) {
                        loader.style.opacity = "0"; 
                        setTimeout(() => { 
                            loader.style.display = "none"; 
                            if (pendingTargetPostId) {
                                checkAndOpenTargetPost();
                            }
                        }, 300);
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
                }, 200);
            } else {
                updateLoaderUI(loadingProgress);
            }
        }, 12);
    }
}

// ==========================================
// 3. BOOKMARK CACHE SANITIZER
// ==========================================
function syncAndSanitizeBookmarks() {
    if (!Array.isArray(savedBooks)) {
        savedBooks = [];
    }
    savedBooks = savedBooks
        .map(item => (typeof item === 'object' && item !== null) ? (item.slug || item.id) : item)
        .filter(item => typeof item === 'string' && item.trim().length > 0);
    localStorage.setItem('spidy_saved_books', JSON.stringify(savedBooks));
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

    function checkAndComplete() {
        if (hasClickedWA && hasClickedTG && hasClickedIG) {
            localStorage.setItem('spidy_community_popup_locked_until', (Date.now() + THREE_DAYS_MS).toString());
            showToast("Community joined successfully!", "success");
            setTimeout(() => { popup.classList.remove('active'); }, 800);
        }
    }

    if (waCard) {
        waCard.onclick = (e) => {
            e.preventDefault();
            if (hasClickedWA || isJoiningWA) return;
            isJoiningWA = true;

            if (waStatus) {
                waStatus.style.pointerEvents = "none";
                waStatus.innerHTML = `<span>Joining...</span> <i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>`;
            }

            window.open('https://whatsapp.com/channel/0029Vb6NBZx1yT2GByTTVf2A', '_blank');

            setTimeout(() => {
                hasClickedWA = true;
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
            if (hasClickedTG || isJoiningTG) return;
            isJoiningTG = true;

            if (tgStatus) {
                tgStatus.style.pointerEvents = "none";
                tgStatus.innerHTML = `<span>Joining...</span> <i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>`;
            }

            window.open('https://t.me/+wJgG-_oBsHkxYTRl', '_blank');

            setTimeout(() => {
                hasClickedTG = true;
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
            if (hasClickedIG || isJoiningIG) return;
            isJoiningIG = true;

            if (igStatus) {
                igStatus.style.pointerEvents = "none";
                igStatus.innerHTML = `<span>Following...</span> <i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>`;
            }

            window.open('https://www.instagram.com/princeyadav_3030', '_blank');

            setTimeout(() => {
                hasClickedIG = true;
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
            if (!hasClickedWA || !hasClickedTG || !hasClickedIG) {
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
    dataToRender.forEach(book => {
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        let isSaved = savedBooks.includes(book.slug) || savedBooks.includes(book.id);
        let bookmarkIcon = isSaved ? 'fas fa-bookmark' : 'far fa-bookmark';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `<div class="book-card" data-slug="${escapeHTML(book.slug)}" data-id="${escapeHTML(book.id)}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="${bookmarkIcon}"></i></div><img src="${secureCoverUrl}" loading="lazy" decoding="async" class="book-image" onerror="window.handleBookCoverError(this, '${secureCoverUrl}')" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
    });

    if (append) {
        container.insertAdjacentHTML('beforeend', htmlChunk);
    } else {
        container.innerHTML = htmlChunk;
    }
}

// Fixed: Silent icon toggle ONLY (No Toast Pill on Bookmark)
function toggleBookmarkLocal(iconElement, slug) {
    const index = savedBooks.indexOf(slug);
    if (index === -1) { 
        savedBooks.push(slug); 
        if (iconElement) iconElement.className = "fas fa-bookmark"; 
    } else { 
        savedBooks.splice(index, 1); 
        if (iconElement) iconElement.className = "far fa-bookmark"; 
    }
    syncAndSanitizeBookmarks();
    if (document.getElementById('bookmarks-panel')?.classList.contains('active')) {
        renderSavedBooksUI(); 
    }
}

function renderSavedBooksUI() {
    const container = document.getElementById("savedBooksContainer"); 
    const noMsg = document.getElementById("no-saved-msg");
    const savedBooksData = booksData.filter(book => savedBooks.includes(book.slug) || savedBooks.includes(book.id));
    
    if (savedBooks.length === 0 || savedBooksData.length === 0) { 
        if (container) container.innerHTML = ""; 
        if (noMsg) noMsg.style.display = "flex"; 
        return; 
    }
    if (noMsg) noMsg.style.display = "none"; 
    let htmlChunk = "";
    savedBooksData.forEach(book => {
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `<div class="book-card" data-slug="${escapeHTML(book.slug)}" data-id="${escapeHTML(book.id)}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="fas fa-bookmark"></i></div><img src="${secureCoverUrl}" loading="lazy" decoding="async" class="book-image" onerror="window.handleBookCoverError(this, '${secureCoverUrl}')" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
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
        const delayMs = isFastFilterFetch ? 300 : 1200;
        await new Promise(resolve => setTimeout(resolve, delayMs));

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
            <div class="promo-slide" data-banner-id="${banner.id}" onclick="window.openBannerModules('${banner.id}')">
                <img src="${imageUrl}" alt="${escapeHTML(banner.title || 'Module Banner')}" class="promo-banner-img" draggable="false" onerror="this.src='https://i.postimg.cc/Pq0JLj3C/file-0000000027dc82119d3731d4bfe9bccf.png'">
            </div>`;
        dotsHTML += `<span class="promo-dot ${idx === 0 ? 'active' : ''}" data-slide="${idx}"></span>`;
    });

    track.innerHTML = slidesHTML;
    dotsWrap.innerHTML = dotsHTML;
    initPromoCarousel();
}

function initPromoCarousel() {
    const track = document.getElementById('promoCarouselTrack');
    const dots = document.querySelectorAll('.promo-dot');
    const totalSlides = dots.length;

    if (!track || totalSlides === 0) return;
    if (promoAutoSlideInterval) clearInterval(promoAutoSlideInterval);

    function goToSlide(index) {
        currentPromoIndex = index;
        track.style.transform = `translateX(-${currentPromoIndex * 100}%)`;
        dots.forEach((dot, idx) => {
            dot.classList.toggle('active', idx === currentPromoIndex);
        });
    }

    function startAutoSlide() {
        clearInterval(promoAutoSlideInterval);
        if (totalSlides > 1) {
            promoAutoSlideInterval = setInterval(() => {
                currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
                goToSlide(currentPromoIndex);
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
            currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            goToSlide(currentPromoIndex);
            startAutoSlide();
        };
    }

    if (nBtn) {
        nBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
            goToSlide(currentPromoIndex);
            startAutoSlide();
        };
    }

    let startX = 0;
    track.ontouchstart = (e) => {
        startX = e.touches[0].clientX;
        clearInterval(promoAutoSlideInterval);
    };

    track.ontouchend = (e) => {
        const diffX = startX - e.changedTouches[0].clientX;
        if (Math.abs(diffX) > 40) {
            if (diffX > 0) currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
            else currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            goToSlide(currentPromoIndex);
        }
        startAutoSlide();
    };

    goToSlide(0);
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
// 8. BOOK DETAIL & READ ONLINE (CLOUDFLARE WORKER)
// ==========================================
async function openDownloadPageLocal(slugOrId, skipPushState = false) {
    if (!isUserLoggedIn) {
        triggerLoginModal();
        return;
    }

    let book = booksData.find(b => b.slug === slugOrId || b.id === slugOrId); 
    if (!book) {
        try {
            const docRef = doc(db, "books", slugOrId);
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                book = docSnap.data();
                book.id = docSnap.id;
                if (!book.slug) book.slug = generateCleanSlug(book.title, book.id);
                booksData.push(book);
            }
        } catch (e) {}
    }

    if (!book) return;
    
    const downloadModal = document.getElementById("downloadModal");
    if (downloadModal) {
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

    document.getElementById("dlReadOnlineBtn").onclick = async function() {
        if (!isUserLoggedIn || !auth.currentUser) { 
            triggerLoginModal();
            return; 
        }
        if (isRequestingPdf) return;
        isRequestingPdf = true;
        
        const btn = document.getElementById("dlReadOnlineBtn"); 
        const originalText = btn.innerHTML; 

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
        
        btn.innerHTML = `<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Ready..`; 
        btn.disabled = true;

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
            btn.innerHTML = originalText; 
            btn.disabled = false; 
            isRequestingPdf = false;
        }
    };

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
function bootApplication() {
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
Bhai, dono screenshots[span_7](start_span)[span_7](end_span)[span_8](start_span)[span_8](end_span) dekh kar exact root cause mil gaya hai—ab koi faltu ya extra cheez touch nahi ki gayi hai. Sidha point par samjho ki ye dono cheezein kyun hui aur is code me kaise 100% theek ki gayi hain:

---

### 🔍 1. Loader `0%` Par Kyun Atka Raha Tha? (Image 1[span_9](start_span)[span_9](end_span))
* **Asli Galti:** 
  Tumhare `app.js` ke Line 59 me ye line likhi thi:
  ```javascript
  let savedBooks = JSON.parse(localStorage.getItem('spidy_saved_books')) || [];
