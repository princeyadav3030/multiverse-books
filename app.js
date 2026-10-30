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

let savedBooks = JSON.parse(localStorage.getItem('spidy_saved_books')) || [];

let dynamicBannersList = [];
let activeBannerData = null;
let activeSubjectKey = null;

let isAppReady = { auth: false, data: false }; 
let hasTransitioned = false;
let isTransitioning = false;
let loadingProgress = 1;
let loaderInterval = null;
let hasRealtimeListenersBound = false;

// URL Check for Direct Deeplinks
const urlParamsCheck = new URLSearchParams(window.location.search);
let isDeepLinkLoad = urlParamsCheck.has('book'); 
let pendingBookSlug = urlParamsCheck.get('book');

// Community Popup Controls & Persistence State
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

// Helper: Clear Active Element Focus
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

// Helper: Check if filter or search is active
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
        loadingProgress += 1.5;
    } else if (loadingProgress < 85) {
        loadingProgress += 0.9;
    } else if (loadingProgress < 95) {
        loadingProgress += isAppReady.data ? 1.5 : 0.3;
    }

    if (loadingProgress > 95 && !isAppReady.data) {
        loadingProgress = 95;
    }

    updateLoaderUI(Math.min(95, loadingProgress));

    if (isAppReady.data && isAppReady.auth) {
        tryTransition();
    } else {
        const nextDelay = loadingProgress > 80 ? (isAppReady.data ? 20 : 150) : 35;
        loaderInterval = setTimeout(runSmoothLoaderTick, nextDelay);
    }
}

// Start Loader Tick Immediately
updateLoaderUI(1);
loaderInterval = setTimeout(runSmoothLoaderTick, 35);

// Fail-safe Timeout: 7 seconds ke baad automatically app open kar dega
setTimeout(() => {
    if (!hasTransitioned) {
        isAppReady.auth = true;
        isAppReady.data = true;
        tryTransition();
    }
}, 7000);

function tryTransition() {
    if (isAppReady.auth && isAppReady.data && !hasTransitioned && !isTransitioning) {
        isTransitioning = true;
        clearTimeout(loaderInterval);

        let finishStep = setInterval(() => {
            loadingProgress += 3;
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
    localStorage.setItem('spidy_saved_books', JSON.stringify(savedBooks));
}

// ==========================================
// 4. COMMUNITY POPUP ENGINE (FORCEFUL & PERSISTENT)
// ==========================================
function initCommunityDualPopup() {
    const popup = document.getElementById('communityPopup');
    if (!popup) return;

    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const lastLockedTime = localStorage.getItem('spidy_community_popup_locked_until');
    const now = Date.now();

    if (lastLockedTime && now < parseInt(lastLockedTime, 10)) return;

    let savedSteps = JSON.parse(localStorage.getItem('spidy_comm_steps') || '{"wa":false,"tg":false,"ig":false}');
    hasClickedWA = !!savedSteps.wa;
    hasClickedTG = !!savedSteps.tg;
    hasClickedIG = !!savedSteps.ig;

    const waCard = document.getElementById('btnJoinWhatsApp');
    const tgCard = document.getElementById('btnJoinTelegram');
    const igCard = document.getElementById('btnJoinInstagram');

    const waStatus = document.getElementById('waStatusBtn');
    const tgStatus = document.getElementById('tgStatusBtn');
    const igStatus = document.getElementById('igStatusBtn');
    const maybeLaterBtn = document.getElementById('communityMaybeLaterBtn');

    function saveStepProgress() {
        localStorage.setItem('spidy_comm_steps', JSON.stringify({
            wa: hasClickedWA,
            tg: hasClickedTG,
            ig: hasClickedIG
        }));
    }

    function syncPopupUI() {
        if (hasClickedWA && waStatus) {
            waStatus.classList.add('completed');
            waStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
        }
        if (hasClickedTG && tgStatus) {
            tgStatus.classList.add('completed');
            tgStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
        }
        if (hasClickedIG && igStatus) {
            igStatus.classList.add('completed');
            igStatus.innerHTML = `<span>Done</span> ${VERIFIED_CHECK_SVG}`;
        }

        const totalDone = (hasClickedWA ? 1 : 0) + (hasClickedTG ? 1 : 0) + (hasClickedIG ? 1 : 0);
        if (maybeLaterBtn) {
            if (totalDone < 3) {
                maybeLaterBtn.innerText = `Join All Channels to Continue (${totalDone}/3)`;
                maybeLaterBtn.style.opacity = "0.75";
            } else {
                maybeLaterBtn.innerText = `Access Spidy Book Hub Now 🚀`;
                maybeLaterBtn.style.opacity = "1";
                maybeLaterBtn.style.background = "#10b981";
                maybeLaterBtn.style.color = "#ffffff";
            }
        }
    }

    syncPopupUI();

    clearTimeout(communityPopupTimer);
    communityPopupTimer = setTimeout(() => {
        const isPdfReading = document.getElementById('pdfViewerOverlay')?.style.display === 'flex';
        if (!isPdfReading) {
            popup.classList.add('active');
        }
    }, 120000);

    function checkAndComplete() {
        saveStepProgress();
        syncPopupUI();
        if (hasClickedWA && hasClickedTG && hasClickedIG) {
            localStorage.setItem('spidy_community_popup_locked_until', (Date.now() + THREE_DAYS_MS).toString());
            localStorage.removeItem('spidy_comm_steps');
            showToast("Community joined successfully!", "success");
            setTimeout(() => { popup.classList.remove('active'); }, 700);
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
                checkAndComplete();
            }, 5500);
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
                checkAndComplete();
            }, 5500);
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
                checkAndComplete();
            }, 5500);
        };
    }

    if (maybeLaterBtn) {
        maybeLaterBtn.onclick = (e) => {
            e.preventDefault();
            if (!hasClickedWA || !hasClickedTG || !hasClickedIG) {
                const missing = [];
                if (!hasClickedWA) missing.push("WhatsApp");
                if (!hasClickedTG) missing.push("Telegram");
                if (!hasClickedIG) missing.push("Instagram");
                showToast(`Please follow ${missing.join(" & ")} to continue`, "error");
                return;
            }
            popup.classList.remove('active');
        };
    }
}

// ==========================================
// 5. MASTER FILTER APPLIER & UI RENDER
// ==========================================
let filterAutoFetchCount = 0;
const MAX_AUTO_FILTER_FETCHES = 3;

function applyMasterFilter(isAppending = false, newBatchData = []) {
    if (!isAppending) {
        filterAutoFetchCount = 0;
    }

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
        } else if (!hasMoreBooksToFetch || filterAutoFetchCount >= MAX_AUTO_FILTER_FETCHES) {
            if (noResultsMsg) noResultsMsg.style.display = 'flex';
        }

        if (infiniteLoader) infiniteLoader.style.display = 'none';

        if (isFilterOrSearchActive() && mainFilteredData.length < 6 && hasMoreBooksToFetch && !isFetchingBooksBatch && filterAutoFetchCount < MAX_AUTO_FILTER_FETCHES) {
            filterAutoFetchCount++;
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
        if (!hasMoreBooksToFetch || filterAutoFetchCount >= MAX_AUTO_FILTER_FETCHES) {
            if (noResultsMsg) noResultsMsg.style.display = 'flex'; 
        } else {
            if (noResultsMsg) noResultsMsg.style.display = 'none';
        }
        if (infiniteLoader) infiniteLoader.style.display = 'none';
    }

    if (isFilterOrSearchActive() && mainFilteredData.length < 6 && hasMoreBooksToFetch && !isFetchingBooksBatch && filterAutoFetchCount < MAX_AUTO_FILTER_FETCHES) {
        filterAutoFetchCount++;
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

        htmlChunk += `<div class="book-card" data-slug="${escapeHTML(book.slug)}" data-id="${escapeHTML(book.id)}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="${bookmarkIcon}"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="window.handleBookCoverError(this, '${secureCoverUrl}')" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
    });

    if (append) {
        container.insertAdjacentHTML('beforeend', htmlChunk);
    } else {
        container.innerHTML = htmlChunk;
    }
}

function toggleBookmarkLocal(iconElement, slug) {
    const index = savedBooks.indexOf(slug);
    if (index === -1) { 
        savedBooks.push(slug); 
        if(iconElement) iconElement.className = "fas fa-bookmark"; 
    } else { 
        savedBooks.splice(index, 1); 
        if(iconElement) iconElement.className = "far fa-bookmark"; 
    }
    syncAndSanitizeBookmarks();
    if(document.getElementById('bookmarks-panel')?.classList.contains('active')) renderSavedBooksUI(); 
}

// Persistent Bookmark Renderer (Direct doc fetch without needing where/documentId)
async function renderSavedBooksUI() {
    const container = document.getElementById("savedBooksContainer"); 
    const noMsg = document.getElementById("no-saved-msg");
    
    if (!savedBooks || savedBooks.length === 0) { 
        if (container) container.innerHTML = ""; 
        if (noMsg) noMsg.style.display = "flex"; 
        return; 
    }

    let savedBooksData = booksData.filter(book => savedBooks.includes(book.slug) || savedBooks.includes(book.id));
    const foundKeys = new Set(savedBooksData.map(b => b.id).concat(savedBooksData.map(b => b.slug)));
    const missingKeys = savedBooks.filter(k => !foundKeys.has(k));

    if (missingKeys.length > 0) {
        const fetchPromises = missingKeys.map(async (key) => {
            try {
                const docSnap = await getDoc(doc(db, "books", key));
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    data.id = docSnap.id;
                    if (!data.slug || data.slug.includes('%')) {
                        data.slug = generateCleanSlug(data.title, data.id);
                    }
                    if (!booksData.some(b => b.id === data.id)) {
                        booksData.push(data);
                    }
                    return data;
                }
            } catch (err) {}
            return null;
        });

        const fetchedItems = await Promise.all(fetchPromises);
        fetchedItems.forEach(item => {
            if (item && !savedBooksData.some(b => b.id === item.id)) {
                savedBooksData.push(item);
            }
        });
    }

    if (savedBooksData.length === 0) { 
        if (container) container.innerHTML = ""; 
        if (noMsg) noMsg.style.display = "flex"; 
        return; 
    }

    if (noMsg) noMsg.style.display = "none"; 
    let htmlChunk = "";
    savedBooksData.forEach(book => {
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `<div class="book-card" data-slug="${escapeHTML(book.slug)}" data-id="${escapeHTML(book.id)}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="fas fa-bookmark"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="window.handleBookCoverError(this, '${secureCoverUrl}')" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
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
        const delayMs = isFastFilterFetch ? 80 : 150;
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
// READ MODULE PDF DIRECTLY
// ==========================================
window.readModulePdfDirectly = async function(pdfKeyOrUrl, title) {
    if (!isUserLoggedIn || !auth.currentUser) {
        triggerLoginModal();
        return;
    }

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
        return;
    }

    try {
        const userToken = await auth.currentUser.getIdToken(true);
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
    }
};

// ==========================================
// 8. BOOK DETAIL & READ ONLINE (SAFE DIRECT FETCH)
// ==========================================
async function openDownloadPageLocal(slugOrId, skipPushState = false) {
    if(!isUserLoggedIn) {
        triggerLoginModal();
        return;
    }

    let book = booksData.find(b => b.slug === slugOrId || b.id === slugOrId);

    // Fallback: Agar shared book batch me na ho, toh direct doc ID se fetch karo
    if (!book && slugOrId) {
        try {
            const docSnap = await getDoc(doc(db, "books", slugOrId));
            if (docSnap.exists()) {
                book = docSnap.data();
                book.id = docSnap.id;
                if (!book.slug || book.slug.includes('%')) {
                    book.slug = generateCleanSlug(book.title, book.id);
                }
                booksData.push(book);
            }
        } catch (e) {
            console.warn("Direct book fetch fallback:", e.message);
        }
    }

    if (!book) {
        showToast("Book not found or link expired", "error");
        return;
    }
    
    const downloadModal = document.getElementById("downloadModal");
    if (downloadModal) {
        downloadModal.style.display = "flex";
        downloadModal.scrollTop = 0;
        const innerContent = downloadModal.querySelector('.dl-content-wrapper') || downloadModal.firstElementChild;
        if (innerContent) innerContent.scrollTop = 0;
    }
    
    const previewImg = document.getElementById("dlPreviewImage");
    if (previewImg) {
        const fullCoverUrl = getSecureAssetUrl(book.image);
        previewImg.src = fullCoverUrl; 
        previewImg.onerror = () => { window.handleBookCoverError(previewImg, fullCoverUrl); };
    }

    document.getElementById("dlBookTitle").innerText = sanitizeHTML(book.title); 
    document.getElementById("dlBookAuthor").innerText = sanitizeHTML(book.author);

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
        if(!isUserLoggedIn || !auth.currentUser) { 
            triggerLoginModal();
            return; 
        }
        
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

        if(!hasValidToken && !IS_SUPER_ADMIN) {
             safePushHistory({ popup: 'tokenModal', returnTo: 'book' });
             const tModal = document.getElementById('tokenModalOverlay');
             if (tModal) tModal.style.display = 'flex';
             return; 
        }
        
        btn.innerHTML = `<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Ready..`; 
        btn.disabled = true;

        try {
            const userToken = await auth.currentUser.getIdToken(true);
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
                if (title) title.innerText = sanitizeHTML(book.title);
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
            btn.innerHTML = originalText; 
            btn.disabled = false;
        } catch (error) { 
            showToast("Failed to load book", "error"); 
            btn.innerHTML = originalText; 
            btn.disabled = false; 
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
document.addEventListener("DOMContentLoaded", () => {
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
            safePushHistory({ popup: 'uploadModal' });
            uploadModal.classList.add('active');
        }
    });

    document.getElementById('closeUploadHubBtn')?.addEventListener('click', () => {
        clearActiveElementFocus();
        if (history.state && history.state.popup === 'uploadModal') {
            history.back();
        } else {
            document.getElementById('uploadModalOverlay')?.classList.remove('active');
        }
    });

    // Report Link Modal Listeners
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
        const selectedOption = document.querySelector('.rm-option.selected');
        if (selectedOption) {
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
            } catch (error) {}

            submitReportBtn.innerHTML = '<i class="fas fa-check-circle"></i> Successfully Reported';
            submitReportBtn.style.background = '#10b981';
            
            setTimeout(() => {
                clearActiveElementFocus();
                if (history.state && history.state.popup === 'reportModal') history.back();
                else document.getElementById('reportModalOverlay')?.classList.remove('active');
                setTimeout(() => {
                    submitReportBtn.innerHTML = 'Submit Report';
                    submitReportBtn.style.background = '#ef4444';
                    submitReportBtn.classList.remove('enabled');
                    reportOptions.forEach(o => o.classList.remove('selected'));
                }, 400);
            }, 1200);
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
        }, { root: document.getElementById('mainContentArea'), rootMargin: '0px 0px 120px 0px', threshold: 0.1 });
        infiniteScrollObserver.observe(sentinel);
    }

    // Book Cards Click Listeners
    document.getElementById('bookContainer')?.addEventListener('click', (e) => {
        const card = e.target.closest('.book-card');
        if(card) {
            const slug = card.getAttribute('data-slug') || card.getAttribute('data-id');
            const bookmarkBtn = e.target.closest('.bookmark-btn');
            if(bookmarkBtn) toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug); 
            else openDownloadPageLocal(slug);
        }
    });

    document.getElementById('savedBooksContainer')?.addEventListener('click', (e) => {
        const card = e.target.closest('.book-card');
        if(card) {
            const slug = card.getAttribute('data-slug') || card.getAttribute('data-id');
            const bookmarkBtn = e.target.closest('.bookmark-btn');
            if(bookmarkBtn) toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug); 
            else openDownloadPageLocal(slug); 
        }
    });

    // Download Modal Listeners
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

    // Sidebar & Menus
    const sidebar = document.getElementById('sidebar'); 
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    document.getElementById('open-menu')?.addEventListener('click', () => { 
        clearActiveElementFocus();
        safePushHistory({ popup: 'sidebar' }); 
        sidebar?.classList.add('active'); 
        sidebarOverlay?.classList.add('active'); 
    });
    sidebarOverlay?.addEventListener('click', () => history.back());

    document.getElementById('menu-home-side')?.addEventListener('click', (e) => {
        e.preventDefault();
        clearActiveElementFocus();
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
        safePushHistory({ popup: 'bookmarks' }); 
        document.getElementById('bookmarks-panel')?.classList.add('active'); 
        sidebar?.classList.remove('active'); 
        sidebarOverlay?.classList.remove('active'); 
        renderSavedBooksUI(); 
    });
    document.getElementById('close-bookmarks-btn')?.addEventListener('click', () => history.back());

    // Master Native Popstate Engine
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
            return;
        }

        const downloadModal = document.getElementById("downloadModal");
        if (downloadModal && downloadModal.style.display === "flex") {
            downloadModal.style.display = "none";
            window.history.replaceState({}, '', window.location.pathname);
            return;
        }

        const notiPanel = document.getElementById('noti-panel');
        if (notiPanel && notiPanel.classList.contains('active')) {
            notiPanel.classList.remove('active');
            if (window.location.hash.includes('post/')) {
                history.replaceState(null, '', window.location.pathname);
            }
            return;
        }

        const sidebar = document.getElementById('sidebar');
        if (sidebar && sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
            document.getElementById('sidebar-overlay')?.classList.remove('active');
            return;
        }

        const bookmarksPanel = document.getElementById('bookmarks-panel');
        if (bookmarksPanel && bookmarksPanel.classList.contains('active')) {
            bookmarksPanel.classList.remove('active');
            return;
        }

        const searchBox = document.getElementById('search-box');
        if (searchBox && searchBox.classList.contains('active')) {
            searchBox.classList.remove('active');
            return;
        }

        applyMasterFilter(false);
    });

    // Custom Module Back Button
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
            }
        }
    });

    // Close PDF Viewer Button
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
});

// ==========================================
// 10. AUTH STATE & LIVE SYNC PIPELINE
// ==========================================
onAuthStateChanged(auth, async (user) => {
    if (user) {
        isUserLoggedIn = true;
        localStorage.setItem('isUserLoggedIn', 'true');

        let dName = user.displayName || (user.email ? user.email.split('@')[0] : "User");
        document.getElementById('sidebarProfileName').innerText = sanitizeHTML(dName);
        
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
            document.getElementById('sidebarRoleText').innerText = IS_SUPER_ADMIN ? "Super Admin" : "Verified User";
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
        document.getElementById('sidebarProfileName').innerText = "SPIDY BOOK HUB";
        document.getElementById('sidebarRoleText').innerText = "Please Login";
        
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
