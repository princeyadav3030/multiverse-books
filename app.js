// File: app.js

import { 
    auth, db, collection, addDoc, doc, getDoc, getDocs, 
    query, orderBy, limit, startAfter, serverTimestamp, onAuthStateChanged, onSnapshot 
} from "./modules/firebase-config.js";

import { 
    getSecureAssetUrl, generateCleanSlug, sanitizeHTML, escapeHTML, 
    stripMarkdown, parseMarkdown, formatViewsCount, formatTime, 
    formatDateDivider, normalizeDate, showToast, DEFAULT_AVATAR, 
    getHighQualityAvatar, generateDeviceFingerprint, formatReactionCount 
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

let livePosts = [];
let activePost = null;
let isInitialChannelLoad = true;
let unreadPostsCount = 0;

let isAppReady = { auth: false, data: false }; 
let hasTransitioned = false;
let loadingProgress = 0;
let loaderInterval;

const urlParamsCheck = new URLSearchParams(window.location.search);
let isDeepLinkLoad = urlParamsCheck.has('book'); 
let pendingBookSlug = urlParamsCheck.get('book');

// Channel elements
const chatBody = document.getElementById('chatBody');
const contextOverlay = document.getElementById('contextOverlay');
const scrollDownWrapper = document.getElementById('scrollDownWrapper');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const unreadBadge = document.getElementById('unreadBadge');
const closeNotiBtn = document.getElementById('close-noti-btn');

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
    <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" fill="#10b981" fill-opacity="0.2" stroke="#10b981" stroke-width="2"/>
    <path d="M8 12.5L10.5 15L16 9.5" stroke="#34d399" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ==========================================
// 2. LOADER & TRANSITION ENGINE
// ==========================================
function updateLoaderUI(percent) {
    const loaderFill = document.getElementById('loaderFill');
    const loaderPercentage = document.getElementById('loaderPercentage');
    const loaderStatusText = document.getElementById('loaderStatusText');
    if (loaderFill) loaderFill.style.width = percent + "%";
    if (loaderPercentage) loaderPercentage.innerText = percent + "%";
    if (loaderStatusText) {
        if (percent < 30) loaderStatusText.innerText = "Initializing System...";
        else if (percent < 60) loaderStatusText.innerText = "Loading Books Securely...";
        else if (percent < 95) loaderStatusText.innerText = "Preparing Content...";
        else loaderStatusText.innerText = "Ready to Launch!";
    }
}

loaderInterval = setInterval(() => {
    if (loadingProgress < 85) {
        loadingProgress += Math.floor(Math.random() * 5) + 3; 
        if (loadingProgress > 85) loadingProgress = 85;
        updateLoaderUI(loadingProgress);
    }
}, 120);

setTimeout(() => {
    isAppReady.auth = true;
    isAppReady.data = true;
    tryTransition();
}, 4500);

function tryTransition() {
    if (isAppReady.auth && isAppReady.data && !hasTransitioned) {
        hasTransitioned = true;
        clearInterval(loaderInterval); 
        
        let fastLoad = setInterval(() => {
            loadingProgress += 5;
            if(loadingProgress >= 100) {
                loadingProgress = 100;
                updateLoaderUI(100);
                clearInterval(fastLoad);

                setTimeout(() => {
                    const mainApp = document.getElementById('mainAppWrapper');
                    if (mainApp) mainApp.style.display = 'block';
                    checkAndOpenTargetPost();

                    if (isDeepLinkLoad && pendingBookSlug) {
                        if (isUserLoggedIn) { 
                            openDownloadPageLocal(pendingBookSlug, true); 
                        } else {
                            triggerLoginModal();
                        }
                    } else {
                        initCommunityDualPopup(); 
                    }
                    const loader = document.getElementById("loaderScreen");
                    if (loader) {
                        loader.style.opacity = "0"; 
                        setTimeout(() => { loader.style.display = "none"; }, 300);
                    }
                }, 350); 
            } else {
                updateLoaderUI(loadingProgress);
            }
        }, 15);
    }
}

// ==========================================
// 3. BOOKMARK CACHE SANITIZER
// ==========================================
function syncAndSanitizeBookmarks() {
    if (!booksData || booksData.length === 0) return;
    const existingSlugs = new Set(booksData.map(b => b.slug));
    const existingIds = new Set(booksData.map(b => b.id));
    savedBooks = savedBooks.filter(item => existingSlugs.has(item) || existingIds.has(item));
    localStorage.setItem('spidy_saved_books', JSON.stringify(savedBooks));
}

// ==========================================
// 4. COMMUNITY POPUP ENGINE (RESTORED CLICKS)
// ==========================================
function initCommunityDualPopup() {
    const popup = document.getElementById('communityPopup');
    if (!popup) return;

    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
    const lastLockedTime = localStorage.getItem('spidy_community_popup_locked_until');
    const now = Date.now();

    if (lastLockedTime && now < parseInt(lastLockedTime, 10)) return;

    clearTimeout(communityPopupTimer);
    communityPopupTimer = setTimeout(() => {
        popup.classList.add('active');
    }, 180000);

    const waCard = document.getElementById('btnJoinWhatsApp');
    const tgCard = document.getElementById('btnJoinTelegram');
    const igCard = document.getElementById('btnJoinInstagram');

    const waStatus = document.getElementById('waStatusBtn');
    const tgStatus = document.getElementById('tgStatusBtn');
    const igStatus = document.getElementById('igStatusBtn');
    const maybeLaterBtn = document.getElementById('communityMaybeLaterBtn');

    function checkAndComplete() {
        if (hasClickedWA && hasClickedTG && hasClickedIG) {
            localStorage.setItem('spidy_community_popup_locked_until', (Date.now() + FIVE_DAYS_MS).toString());
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

            window.open('https://t.me/MultiverseBooks', '_blank');

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

            window.open('https://www.instagram.com/PRINCE_YADAV_3030', '_blank');

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
// 5. CHANNEL POSTS & LIVE NOTIFICATIONS ENGINE
// ==========================================
function renderChannelLoader() {
    if (!chatBody) return;
    chatBody.innerHTML = `
        <div class="empty-loading" id="channelLoader">
            <div class="orbit-spinner">
                <div class="orbit-ring"></div>
                <div class="orbit-inner-ring"></div>
                <div class="orbit-core"></div>
            </div>
            Connecting to live updates...
        </div>`;
}

function getUserReaction(postId) { return localStorage.getItem(`reaction_${postId}`); }
function setUserReaction(postId, emoji) {
    if (emoji) localStorage.setItem(`reaction_${postId}`, emoji);
    else localStorage.removeItem(`reaction_${postId}`);
}

function forceScrollChatToBottom() {
    if (!chatBody) return;
    unreadPostsCount = 0;
    if (unreadBadge) {
        unreadBadge.innerText = '0';
        unreadBadge.classList.remove('active');
    }
    if (scrollDownWrapper) {
        scrollDownWrapper.classList.remove('show');
    }

    chatBody.scrollTop = chatBody.scrollHeight + 1000;
    requestAnimationFrame(() => {
        chatBody.scrollTop = chatBody.scrollHeight + 1000;
    });
}

function scrollToBottomSmooth() {
    unreadPostsCount = 0;
    if (unreadBadge) {
        unreadBadge.innerText = '0';
        unreadBadge.classList.remove('active');
    }
    chatBody.scrollTo({ top: chatBody.scrollHeight + 1000, behavior: 'smooth' });
}

if (scrollDownBtn) scrollDownBtn.addEventListener('click', scrollToBottomSmooth);

if (chatBody) {
    chatBody.addEventListener('scroll', () => {
        const distanceFromBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight;
        if (distanceFromBottom > 140) {
            scrollDownWrapper?.classList.add('show');
        } else {
            scrollDownWrapper?.classList.remove('show');
            unreadPostsCount = 0;
            if (unreadBadge) {
                unreadBadge.innerText = '0';
                unreadBadge.classList.remove('active');
            }
        }
    }, { passive: true });
}

window.scrollToChannelPost = function(postId) {
    if (!postId) return;
    const target = document.getElementById(`post_${postId}`);
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('highlight-post');
        void target.offsetWidth; 
        target.classList.add('highlight-post');
        setTimeout(() => target.classList.remove('highlight-post'), 2900);
    }
};

function buildReactionsHTML(reactionsObj, userSelectedEmoji) {
    if (!reactionsObj) return '';
    const sortedReactions = Object.entries(reactionsObj)
        .filter(([_, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);

    let pillsHTML = '';
    sortedReactions.forEach(([emoji, count]) => {
        const isActive = userSelectedEmoji === emoji ? 'active' : '';
        pillsHTML += `
            <div class="reaction-pill ${isActive}" data-emoji="${emoji}">
                <span class="emoji">${emoji}</span>
                <span class="count">${formatReactionCount(count)}</span>
            </div>`;
    });
    return pillsHTML;
}

function updateReactionInDOM(postId) {
    const post = livePosts.find(p => p.id === postId);
    const bubble = document.getElementById(`post_${postId}`);
    if (!post || !bubble) return;

    const userSelectedEmoji = getUserReaction(postId);
    const reactionsContainer = bubble.querySelector('.inline-reactions');
    if (reactionsContainer) {
        reactionsContainer.innerHTML = buildReactionsHTML(post.reactions, userSelectedEmoji);
        reactionsContainer.querySelectorAll('.reaction-pill').forEach(pill => {
            pill.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                applyReaction(post.id, pill.dataset.emoji);
            });
        });
    }
}

async function registerUniqueView(postId) {
    if (!auth.currentUser) return;
    try {
        const token = await auth.currentUser.getIdToken(false);
        await fetch('/api/channel-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'view', postId, userToken: token })
        });
    } catch (err) {}
}

const postViewObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const postId = entry.target.dataset.postId;
            if (postId) registerUniqueView(postId);
        }
    });
}, { threshold: 0.5 });

function renderChannelFeed(posts, isInitialOrPanelOpen = false) {
    if (!chatBody) return;

    if (!posts || posts.length === 0) {
        chatBody.innerHTML = `
            <div class="empty-loading">
                <i class="fas fa-bullhorn" style="font-size:26px; color:var(--text-secondary); opacity:0.6;"></i>
                No channel updates posted yet.
            </div>`;
        return;
    }

    if (postViewObserver) postViewObserver.disconnect();

    const fragment = document.createDocumentFragment();
    let lastDateStr = '';

    posts.forEach(post => {
        const dateObj = normalizeDate(post.createdAt);
        const dateStr = formatDateDivider(dateObj);

        if (dateStr !== lastDateStr) {
            const divider = document.createElement('div');
            divider.className = 'date-divider';
            divider.innerText = dateStr;
            fragment.appendChild(divider);
            lastDateStr = dateStr;
        }

        const userSelectedEmoji = getUserReaction(post.id);
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.id = `post_${post.id}`;
        bubble.dataset.postId = post.id;

        let imageHTML = post.imageUrl 
            ? `<img src="${getSecureAssetUrl(post.imageUrl)}" loading="lazy" class="msg-image" alt="Post Image">` 
            : '';

        let quoteHTML = '';
        if (post.quote) {
            const targetId = post.quote.targetPostId || '';
            const cleanSnippet = sanitizeHTML(stripMarkdown(post.quote.text || ''));
            quoteHTML = `
            <div class="msg-quote" onclick="event.stopPropagation(); window.scrollToChannelPost('${targetId}')">
                 <div class="quote-author">SPIDY BOOK HUB</div>
                 <div class="quote-text">${cleanSnippet}</div>
            </div>`;
        }

        const reactionPillsHTML = buildReactionsHTML(post.reactions, userSelectedEmoji);

        bubble.innerHTML = `
            ${quoteHTML}
            ${imageHTML}
            <div class="msg-text">${parseMarkdown(post.text)}</div>
            <div class="post-footer">
                <div class="inline-reactions">${reactionPillsHTML}</div>
                <div class="msg-meta">
                    <i class="fas fa-eye"></i> ${formatViewsCount(post.views || 1)} &nbsp; ${formatTime(dateObj)}
                </div>
            </div>
        `;

        bubble.querySelectorAll('.reaction-pill').forEach(pill => {
            pill.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                applyReaction(post.id, pill.dataset.emoji);
            });
        });

        bubble.addEventListener('click', (e) => {
            if (
                e.target.tagName === 'A' || 
                e.target.closest('.tg-copy-action-btn') || 
                e.target.closest('.telegram-copy-btn') ||
                e.target.closest('.reaction-pill') ||
                e.target.closest('.tg-copy-card')
            ) {
                return;
            }
            if (!isUserLoggedIn || !auth.currentUser) {
                triggerLoginModal();
                return;
            }
            activePost = post;
            if (contextOverlay) contextOverlay.classList.add('show');
            if (navigator.vibrate) navigator.vibrate(20);
        });

        fragment.appendChild(bubble);
        postViewObserver.observe(bubble);
    });

    const hasTargetPost = window.location.hash.includes("post/") || new URLSearchParams(window.location.search).has("post");

    if (isInitialOrPanelOpen && !hasTargetPost) {
        chatBody.style.visibility = 'hidden';
        chatBody.innerHTML = '';
        chatBody.appendChild(fragment);

        requestAnimationFrame(() => {
            chatBody.scrollTop = chatBody.scrollHeight + 1000;
            requestAnimationFrame(() => {
                chatBody.scrollTop = chatBody.scrollHeight + 1000;
                chatBody.style.visibility = 'visible';
            });
        });
    } else {
        const prevScrollTop = chatBody.scrollTop;
        chatBody.innerHTML = '';
        chatBody.appendChild(fragment);
        chatBody.style.visibility = 'visible';
        if (!hasTargetPost) {
            chatBody.scrollTop = prevScrollTop;
        }
    }
}

async function applyReaction(postId, newEmoji) {
    if (!isUserLoggedIn || !auth.currentUser) {
        triggerLoginModal();
        return;
    }
    
    const existing = getUserReaction(postId);
    if (existing === newEmoji) return;

    setUserReaction(postId, newEmoji);
    const pIdx = livePosts.findIndex(p => p.id === postId);
    if (pIdx !== -1) {
        livePosts[pIdx].reactions = livePosts[pIdx].reactions || {};
        if (existing && livePosts[pIdx].reactions[existing]) {
            livePosts[pIdx].reactions[existing] = Math.max(0, livePosts[pIdx].reactions[existing] - 1);
        }
        livePosts[pIdx].reactions[newEmoji] = (livePosts[pIdx].reactions[newEmoji] || 0) + 1;
        updateReactionInDOM(postId);
    }
    if (navigator.vibrate) navigator.vibrate(15);

    try {
        const token = await auth.currentUser.getIdToken(false);
        const res = await fetch('/api/channel-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'reaction', postId, emoji: newEmoji, userToken: token })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || "Reaction failed", "error");
        }
    } catch (e) {}
}

if (contextOverlay) {
    contextOverlay.addEventListener('click', (e) => {
        if (e.target === contextOverlay) contextOverlay.classList.remove('show');
    });

    document.querySelectorAll('.cm-emoji').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const emoji = el.getAttribute('data-emoji');
            if (activePost && emoji) {
                applyReaction(activePost.id, emoji);
                contextOverlay.classList.remove('show');
                activePost = null;
            }
        });
    });

    document.getElementById('cmCopyText')?.addEventListener('click', () => {
        if (!activePost) return;
        navigator.clipboard.writeText(stripMarkdown(activePost.text));
        contextOverlay.classList.remove('show');
    });

    document.getElementById('cmCopyLink')?.addEventListener('click', () => {
        if (!activePost) return;
        const cleanBase = window.location.origin + window.location.pathname;
        const url = `${cleanBase}#/post/${activePost.id}`;
        navigator.clipboard.writeText(url);
        contextOverlay.classList.remove('show');
    });

    document.getElementById('cmForward')?.addEventListener('click', () => {
        if (!activePost) return;
        const cleanBase = window.location.origin + window.location.pathname;
        const url = `${cleanBase}#/post/${activePost.id}`;
        const cleanText = stripMarkdown(activePost.text);
        if (navigator.share) {
            navigator.share({ title: 'SPIDY BOOK HUB', text: cleanText, url: url }).catch(() => {});
        } else {
            navigator.clipboard.writeText(url);
        }
        contextOverlay.classList.remove('show');
    });

    document.getElementById('cmReport')?.addEventListener('click', () => {
        contextOverlay.classList.remove('show');
    });
}

document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.telegram-copy-btn, .tg-copy-action-btn');
    if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        
        let copyTargetText = "";
        const rawData = copyBtn.getAttribute('data-clipboard');
        if (rawData) copyTargetText = decodeURIComponent(rawData);

        if (!copyTargetText) {
            const card = copyBtn.closest('.tg-copy-card, .telegram-prompt-card');
            if (card) {
                const bodyEl = card.querySelector('.telegram-prompt-body, .tg-copy-body');
                if (bodyEl) copyTargetText = bodyEl.textContent.trim();
            }
        }

        if (copyTargetText) {
            navigator.clipboard.writeText(copyTargetText).then(() => {
                copyBtn.classList.add('copied-active');
                const orig = copyBtn.innerHTML;
                copyBtn.innerHTML = `<i class="fas fa-check"></i> COPIED!`;
                setTimeout(() => {
                    copyBtn.classList.remove('copied-active');
                    copyBtn.innerHTML = orig;
                }, 2000);
            });
        }
    }
}, true);

// ==========================================
// 6. MASTER FILTER APPLIER & UI RENDER
// ==========================================
function applyMasterFilter(isAppending = false, newBatchData = []) {
    const searchInputRaw = (document.getElementById('app-search-input')?.value || "").trim();
    const rawLower = searchInputRaw.toLowerCase();
    const cleanSearchNoSpaces = rawLower.replace(/[^\p{L}\p{N}]/gu, '');
    const searchWords = rawLower.split(/\s+/).filter(w => w.length > 0);

    const infiniteLoader = document.getElementById('infinite-loader');

    if (isAppending && newBatchData.length > 0) {
        const filteredNewItems = newBatchData.filter(book => 
            matchBookFilters(book, searchInputRaw, cleanSearchNoSpaces, searchWords)
        );
        mainFilteredData.push(...filteredNewItems);
        renderBooksUI(filteredNewItems, true);
        if (infiniteLoader) infiniteLoader.style.display = 'none';
        return;
    }

    mainFilteredData = booksData.filter(book => 
        matchBookFilters(book, searchInputRaw, cleanSearchNoSpaces, searchWords)
    );
    
    if (mainFilteredData.length > 0) { 
        document.getElementById('no-results-msg').style.display = 'none'; 
        if (infiniteLoader) infiniteLoader.style.display = 'none';
        renderBooksUI(mainFilteredData, false); 
    } else { 
        document.getElementById("bookContainer").innerHTML = ""; 
        document.getElementById('no-results-msg').style.display = 'flex'; 
        if (infiniteLoader) infiniteLoader.style.display = 'none';
    }
}

function renderBooksUI(dataToRender, append = false) {
    const container = document.getElementById("bookContainer");
    if (!container) return;
    let htmlChunk = "";
    dataToRender.forEach(book => {
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        let isSaved = savedBooks.includes(book.slug) || savedBooks.includes(book.id);
        let bookmarkIcon = isSaved ? 'fas fa-bookmark' : 'far fa-bookmark';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `<div class="book-card" data-slug="${book.slug}" data-id="${book.id}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="${bookmarkIcon}"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
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
    localStorage.setItem('spidy_saved_books', JSON.stringify(savedBooks));
    syncAndSanitizeBookmarks();
    if(document.getElementById('bookmarks-panel')?.classList.contains('active')) renderSavedBooksUI(); 
}

function renderSavedBooksUI() {
    syncAndSanitizeBookmarks();
    const container = document.getElementById("savedBooksContainer"); 
    const noMsg = document.getElementById("no-saved-msg");
    const savedBooksData = booksData.filter(book => savedBooks.includes(book.slug) || savedBooks.includes(book.id));
    
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

        htmlChunk += `<div class="book-card" data-slug="${book.slug}" data-id="${book.id}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="fas fa-bookmark"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
    });
    if (container) container.innerHTML = htmlChunk;
}

// ==========================================
// 7. REALTIME PAGINATION & DATA FETCH
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

async function loadNextBooksBatch() {
    if (!hasMoreBooksToFetch || isFetchingBooksBatch || !lastVisibleBookDoc) return;
    isFetchingBooksBatch = true;

    const infiniteLoader = document.getElementById('infinite-loader');
    if (infiniteLoader) infiniteLoader.style.display = 'flex';

    try {
        await new Promise(resolve => setTimeout(resolve, 1500));

        const booksRef = collection(db, "books");
        const q = query(booksRef, orderBy("createdAt", "desc"), startAfter(lastVisibleBookDoc), limit(BATCH_SIZE));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            hasMoreBooksToFetch = false;
            if (infiniteLoader) infiniteLoader.style.display = 'none';
            isFetchingBooksBatch = false;
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
        applyMasterFilter(true, newItems);

    } catch (err) {
        if (infiniteLoader) infiniteLoader.style.display = 'none';
    } finally {
        isFetchingBooksBatch = false;
        if (!hasMoreBooksToFetch && infiniteLoader) {
            infiniteLoader.style.display = 'none';
        }
    }
}

// ==========================================
// 8. PROMO CAROUSEL & MODULE PACKS
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
                <img src="${imageUrl}" alt="${escapeHTML(banner.title || 'Module Banner')}" class="promo-banner-img" draggable="false">
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
    
    const instEl = document.getElementById('moduleInstituteText');
    if (instEl) instEl.innerText = banner.institute || "Physics Wallah";

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
        history.pushState({ popup: 'moduleBanner' }, '');
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
        modules.forEach(mod => {
            const rawPdfUrl = mod.pdfLink || "";
            const safeEncodedKey = encodeURIComponent(rawPdfUrl);
            const encodedTitle = encodeURIComponent(mod.name || "Module Document");
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
                    <div class="module-title-h3">${escapeHTML(mod.name || 'Module')}</div>
                    <span class="module-tag-pages"><i class="fas fa-layer-group"></i> ${escapeHTML(pageLabel)}</span>
                </div>
                <div class="pod-round-arrow-wrap"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg></div>
            </div>`;
        });
        container.innerHTML = html;
    }

    history.pushState({ popup: 'moduleList', subjectKey: subjectKey }, '');
    document.getElementById('bannerSubjectsView').classList.add('hidden-view');
    document.getElementById('bannerModulesView').classList.remove('hidden-view');
};

window.readModulePdfDirectly = async function(pdfKeyOrUrl, title) {
    if (!isUserLoggedIn || !auth.currentUser) {
        triggerLoginModal();
        return;
    }

    const savedData = localStorage.getItem('spidy_secure_session');
    let hasValidToken = false;
    if (savedData) {
        try {
            const parsed = JSON.parse(savedData);
            if (parsed.fp === generateDeviceFingerprint(auth.currentUser?.uid) && parsed.expiry > Date.now()) {
                hasValidToken = true;
            }
        } catch(e) {}
    }

    if (!hasValidToken && !IS_SUPER_ADMIN) {
        history.pushState({ popup: 'tokenModal', returnTo: 'module' }, '');
        const tModal = document.getElementById('tokenModalOverlay');
        if (tModal) tModal.style.display = 'flex';
        return;
    }

    const pdfViewer = document.getElementById('pdfViewerOverlay');
    const titleEl = document.getElementById('pdfViewerTitle');

    if (titleEl) titleEl.innerText = title || "Reading Module...";
    if (pdfViewer) {
        history.pushState({ popup: 'pdfViewer', from: 'module' }, '');
        pdfViewer.style.display = 'flex';
    }

    showCenteredPdfLoader("Just a Moment… Your Module Is Almost Ready..!! 🚀📚");

    if (!pdfKeyOrUrl || pdfKeyOrUrl.trim() === "") {
        renderPdfInModal("", true, "module", activeBannerData?.id); 
        return;
    }

    try {
        const userToken = await auth.currentUser.getIdToken(true);
        const response = await fetch('/api/get-book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                pdfKey: pdfKeyOrUrl,
                bookSlug: (activeBannerData ? activeBannerData.id : "module-pack"),
                userToken: userToken,
                fingerprint: generateDeviceFingerprint(auth.currentUser?.uid)
            })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            renderPdfInModal(data.pdfLink, true, "module", activeBannerData?.id);
        } else {
            renderPdfInModal(getSecureAssetUrl(pdfKeyOrUrl), true, "module", activeBannerData?.id);
        }
    } catch (err) {
        renderPdfInModal(getSecureAssetUrl(pdfKeyOrUrl), true, "module", activeBannerData?.id);
    }
};

// ==========================================
// 9. BOOK DETAIL & READ ONLINE
// ==========================================
function openDownloadPageLocal(slugOrId, skipPushState = false) {
    if(!isUserLoggedIn) {
        triggerLoginModal();
        return;
    }
    const book = booksData.find(b => b.slug === slugOrId || b.id === slugOrId); 
    if(!book) return;
    
    const downloadModal = document.getElementById("downloadModal");
    if (downloadModal) downloadModal.style.display = "flex";

    downloadModal.scrollTop = 0;
    const innerScrollWrapper = downloadModal.querySelector('.download-content-wrapper') || downloadModal.firstElementChild;
    if (innerScrollWrapper) innerScrollWrapper.scrollTop = 0;
    
    const previewImg = document.getElementById("dlPreviewImage");
    if (previewImg) {
        previewImg.src = getSecureAssetUrl(book.image); 
        previewImg.onerror = () => { previewImg.src = DEFAULT_AVATAR; };
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
        totalPagesSub.innerText = (!isNaN(pNum) && pNum > 0) ? `${pNum} Pages Included` : `${book.totalPages || "1"} Pages Included`;
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
        if (savedData) {
            try {
                const parsed = JSON.parse(savedData);
                if (parsed.fp === generateDeviceFingerprint(auth.currentUser?.uid) && parsed.expiry > Date.now()) {
                    hasValidToken = true;
                }
            } catch(e) {}
        }

        if(!hasValidToken && !IS_SUPER_ADMIN) {
             history.pushState({ popup: 'tokenModal', returnTo: 'book' }, '');
             const tModal = document.getElementById('tokenModalOverlay');
             if (tModal) tModal.style.display = 'flex';
             return; 
        }
        
        btn.innerHTML = `<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Ready..`; 
        btn.disabled = true;

        try {
            const userToken = await auth.currentUser.getIdToken(true);
            const response = await fetch('/api/get-book', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    bookId: book.id, 
                    bookSlug: book.slug || book.id, 
                    userToken: userToken 
                })
            });

            const data = await response.json();
            if (response.ok && data.success) {
                const pdfViewer = document.getElementById('pdfViewerOverlay');
                const title = document.getElementById('pdfViewerTitle');
                if (title) title.innerText = sanitizeHTML(book.title);
                history.pushState({ popup: 'pdfViewer', from: 'book' }, '');
                if (pdfViewer) pdfViewer.style.display = 'flex';
                renderPdfInModal(data.pdfLink, false, "book", book.slug);
            } else {
                showToast(data.error || "Access denied", "error");
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
        history.pushState({ popup: 'book' }, '', '?book=' + (book.slug || book.id)); 
    }
}

function closeDownloadPageLocal() {
    if (history.state && history.state.popup === 'book') { 
        history.back(); 
    } else { 
        document.getElementById("downloadModal").style.display = "none"; 
        window.history.replaceState({}, '', window.location.pathname); 
    }
}

// ==========================================
// 10. NOTIFICATION TARGET SCROLL
// ==========================================
function checkAndOpenTargetPost() {
    let targetPostId = "";
    const hash = window.location.hash || "";
    if (hash.includes("post/")) {
        targetPostId = hash.split("post/")[1].replace(/[^a-zA-Z0-9_-]/g, '');
    }
    const params = new URLSearchParams(window.location.search);
    if (!targetPostId && params.has("post")) targetPostId = params.get("post");

    if (targetPostId) {
        const notiPanel = document.getElementById('noti-panel');
        if (notiPanel && !notiPanel.classList.contains('active')) {
            history.pushState({ popup: 'noti' }, '');
            notiPanel.classList.add('active');
        }
        setTimeout(() => {
            const el = document.getElementById(`post_${targetPostId}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 500);
    }
}

// ==========================================
// 11. EVENT LISTENERS & MOBILE BACK HANDLER
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    // 1. Initialize Sub-modules
    initAuthSystem(() => {
        if (isDeepLinkLoad && pendingBookSlug) {
            document.getElementById('mainAppWrapper').style.display = 'block';
            setTimeout(() => openDownloadPageLocal(pendingBookSlug, true), 300);
        }
    });

    initFiltersEngine(() => booksData, () => applyMasterFilter());
    initPdfViewerUI();
    initUploadPipeline(() => IS_SUPER_ADMIN, (newBook) => {
        booksData.unshift(newBook);
        allAuthorsCache.add(newBook.author);
        allYearsCache.add(newBook.year);
        applyMasterFilter();
    });

    // 2. Header Buttons Event Listeners
    document.getElementById('open-search')?.addEventListener('click', () => { 
        history.pushState({ popup: 'search' }, ''); 
        document.getElementById('search-box')?.classList.add('active'); 
        setTimeout(() => { document.getElementById('app-search-input')?.focus(); }, 300); 
    });

    document.getElementById('open-noti')?.addEventListener('click', () => { 
        if (!isUserLoggedIn || !auth.currentUser) {
            triggerLoginModal();
            return;
        }

        history.pushState({ popup: 'noti' }, ''); 
        document.getElementById('noti-panel')?.classList.add('active'); 
        
        const blinkDot = document.querySelector('.blink-dot');
        if (blinkDot) blinkDot.style.display = 'none'; 

        if (livePosts.length > 0) {
            const hasTarget = window.location.hash.includes("post/") || new URLSearchParams(window.location.search).has("post");
            renderChannelFeed(livePosts, !hasTarget);
            if (!hasTarget) {
                setTimeout(forceScrollChatToBottom, 60);
            } else {
                checkAndOpenTargetPost();
            }
        } else {
            renderChannelLoader();
        }
    });

    document.getElementById('close-noti-btn')?.addEventListener('click', () => {
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
        if (!isUserLoggedIn || !auth.currentUser) {
            triggerLoginModal();
            return;
        }

        const uploadModal = document.getElementById('uploadModalOverlay');
        if (uploadModal) {
            history.pushState({ popup: 'uploadModal' }, '');
            uploadModal.classList.add('active');
        }
    });

    document.getElementById('closeUploadHubBtn')?.addEventListener('click', () => {
        if (history.state && history.state.popup === 'uploadModal') {
            history.back();
        } else {
            document.getElementById('uploadModalOverlay')?.classList.remove('active');
        }
    });

    // 3. Support Modal Listeners
    document.getElementById('menu-contact')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('sidebar')?.classList.remove('active');
        document.getElementById('sidebar-overlay')?.classList.remove('active');
        
        if (!isUserLoggedIn || !auth.currentUser) {
            triggerLoginModal();
            return;
        }

        history.pushState({ popup: 'support' }, '');
        document.getElementById('supportModalOverlay')?.classList.add('active');

        const supEmail = document.getElementById('supEmail');
        if (supEmail && auth.currentUser) {
            supEmail.value = auth.currentUser.email || "";
            supEmail.readOnly = true;
        }
    });

    document.getElementById('closeSupportBtn')?.addEventListener('click', () => {
        if (history.state && history.state.popup === 'support') {
            history.back();
        } else {
            document.getElementById('supportModalOverlay')?.classList.remove('active');
        }
    });

    document.getElementById('openIssueModalBtn')?.addEventListener('click', () => {
        document.getElementById('issueModal')?.classList.add('active');
    });

    document.getElementById('closeIssueModalBtn')?.addEventListener('click', () => {
        document.getElementById('issueModal')?.classList.remove('active');
    });

    document.getElementById('issueModal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('issueModal')) {
            document.getElementById('issueModal').classList.remove('active');
        }
    });

    const issueOptions = document.querySelectorAll('#issueModal .modal-option-btn');
    issueOptions.forEach(option => {
        option.addEventListener('click', () => {
            issueOptions.forEach(btn => btn.classList.remove('selected'));
            option.classList.add('selected');
            
            const selectedValue = option.getAttribute('data-value');
            document.getElementById('selectedSubjectInput').value = selectedValue;
            document.getElementById('selectedSubjectDisplay').innerText = selectedValue;
            
            setTimeout(() => {
                document.getElementById('issueModal')?.classList.remove('active');
            }, 150);
        });
    });

    // 4. Global Infinite Scroll Observer
    const sentinel = document.getElementById('scroll-sentinel');
    if (sentinel) {
        const infiniteScrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && hasMoreBooksToFetch && !isFetchingBooksBatch) {
                    loadNextBooksBatch();
                }
            });
        }, { root: document.getElementById('mainContentArea'), rootMargin: '0px 0px 300px 0px', threshold: 0.1 });
        infiniteScrollObserver.observe(sentinel);
    }

    // 5. Book Selection & Bookmark Clicks
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

    // 6. Download Modal Actions
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

    // 7. Sidebar & Navigation
    const sidebar = document.getElementById('sidebar'); 
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    document.getElementById('open-menu')?.addEventListener('click', () => { 
        history.pushState({ popup: 'sidebar' }, ''); 
        sidebar?.classList.add('active'); 
        sidebarOverlay?.classList.add('active'); 
    });
    sidebarOverlay?.addEventListener('click', () => history.back());

    document.getElementById('menu-home-side')?.addEventListener('click', (e) => {
        e.preventDefault();
        sidebar?.classList.remove('active');
        sidebarOverlay?.classList.remove('active');
        document.getElementById('mainContentArea')?.scrollTo({ top: 0, behavior: 'smooth' });
    });

    document.getElementById('menu-bookmarks')?.addEventListener('click', (e) => { 
        e.preventDefault(); 
        history.pushState({ popup: 'bookmarks' }, ''); 
        document.getElementById('bookmarks-panel')?.classList.add('active'); 
        sidebar?.classList.remove('active'); 
        sidebarOverlay?.classList.remove('active'); 
        renderSavedBooksUI(); 
    });
    document.getElementById('close-bookmarks-btn')?.addEventListener('click', () => history.back());

    // 8. Mobile Native Step-by-Step Back Navigation (Strict Hierarchy)
    window.addEventListener('popstate', (e) => {
        // Priority 1: Login Overlay
        const loginOverlay = document.getElementById('loginOverlay');
        if (loginOverlay && (loginOverlay.style.display === 'flex' || loginOverlay.style.opacity === '1')) {
            loginOverlay.style.opacity = '0';
            setTimeout(() => { loginOverlay.style.display = 'none'; }, 400);
            return;
        }

        // Priority 2: Filter Sub-options Modal
        const subFilterModal = document.getElementById('subFilterModalOverlay');
        if (subFilterModal && subFilterModal.classList.contains('active')) {
            closeSubFilterModal();
            return;
        }

        // Priority 3: 4-Box Main Filter Card
        const mainFilterModal = document.getElementById('mainFilterOverlay');
        if (mainFilterModal && mainFilterModal.classList.contains('active')) {
            closeMainFilterModal();
            return;
        }

        // Priority 4: PDF Reader View
        const pdfViewer = document.getElementById('pdfViewerOverlay');
        if (pdfViewer && pdfViewer.style.display === 'flex') {
            pdfViewer.style.display = 'none';
            const scroller = document.getElementById('pdfScrollContainer');
            if (scroller) scroller.innerHTML = '';
            cleanupPdfResources();
            return;
        }

        // Priority 5: Token Modal
        const tokenModal = document.getElementById('tokenModalOverlay');
        if (tokenModal && tokenModal.style.display === 'flex') {
            tokenModal.style.display = 'none';
            return;
        }

        // Priority 6: Support & Issues Modal
        const issueModal = document.getElementById('issueModal');
        if (issueModal && issueModal.classList.contains('active')) {
            issueModal.classList.remove('active');
            return;
        }

        const supportModal = document.getElementById('supportModalOverlay');
        if (supportModal && supportModal.classList.contains('active')) {
            supportModal.classList.remove('active');
            return;
        }

        // Priority 7: Upload Modal
        const uploadModal = document.getElementById('uploadModalOverlay');
        if (uploadModal && uploadModal.classList.contains('active')) {
            const sectionPrompt = document.getElementById('sectionPrompt');
            if (sectionPrompt && sectionPrompt.classList.contains('active')) {
                document.getElementById('admTabAdd')?.click();
                return;
            }
            uploadModal.classList.remove('active');
            return;
        }

        // Priority 8: Module Packs Hierarchy
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

        // Priority 9: Notification Channel Panel
        const notiPanel = document.getElementById('noti-panel');
        if (notiPanel && notiPanel.classList.contains('active')) {
            notiPanel.classList.remove('active');
            if (window.location.hash.includes('post/')) {
                history.replaceState(null, '', window.location.pathname);
            }
            return;
        }

        // Priority 10: Sidebar Navigation
        const sidebar = document.getElementById('sidebar');
        if (sidebar && sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
            document.getElementById('sidebar-overlay')?.classList.remove('active');
            return;
        }

        // Priority 11: Saved Books Panel
        const bookmarksPanel = document.getElementById('bookmarks-panel');
        if (bookmarksPanel && bookmarksPanel.classList.contains('active')) {
            bookmarksPanel.classList.remove('active');
            return;
        }

        // Priority 12: Search Box
        const searchBox = document.getElementById('search-box');
        if (searchBox && searchBox.classList.contains('active')) {
            searchBox.classList.remove('active');
            return;
        }

        // Priority 13: Download Details Modal
        const downloadModal = document.getElementById("downloadModal");
        if (downloadModal && downloadModal.style.display === "flex") {
            downloadModal.style.display = "none";
            window.history.replaceState({}, '', window.location.pathname);
            return;
        }

        applyMasterFilter();
    });

    // 9. Module Back Navigation
    document.getElementById('moduleBackBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
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

    // 10. Close PDF Viewer Button
    document.getElementById("closePdfViewerBtn")?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pdfViewer = document.getElementById('pdfViewerOverlay');
        if (pdfViewer) pdfViewer.style.display = 'none';
        document.getElementById('pdfScrollContainer').innerHTML = ''; 
        cleanupPdfResources();
        if (history.state && history.state.popup === 'pdfViewer') history.back();
    });
});

// ==========================================
// 12. AUTH STATE & LIVE SYNC PIPELINE
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

    // Realtime Prompts Loader (Fixed "Loading prompts..." freeze)
    onSnapshot(query(collection(db, "prompts"), orderBy("createdAt", "asc")), (snapshot) => {
        const container = document.getElementById('promptsContainer');
        if (!container) return;
        container.innerHTML = '';
        if (snapshot.empty) { 
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#8b949e; font-weight:700;">No prompts available yet.</div>`; 
            return; 
        }
        snapshot.forEach(docSnap => {
            const data = docSnap.data(); 
            const safeText = sanitizeHTML(data.text);
            const safeInstruction = data.instruction ? sanitizeHTML(data.instruction).replace(/\n/g, "<br>") : "";
            const safeTitle = sanitizeHTML(data.title || "Book Name & Author");
            let instructionHTML = '';
            if (safeInstruction) { 
                instructionHTML = `<div class="prompt-instruction-text">${safeInstruction}</div>`; 
            }
            container.innerHTML += `
            <div class="telegram-prompt-wrapper">
                ${instructionHTML}
                <div class="telegram-prompt-card">
                    <div class="telegram-prompt-header"><span>${safeTitle}</span></div>
                    <div class="telegram-prompt-body">${safeText}</div>
                    <div class="telegram-prompt-footer">
                        <button type="button" class="telegram-copy-btn" data-clipboard="${encodeURIComponent(data.text)}">
                            <i class="far fa-copy"></i> COPY CODE
                        </button>
                    </div>
                </div>
            </div>`;
        });
    });

    // Realtime Channel Posts Listener
    renderChannelLoader();
    const channelQuery = query(collection(db, "channel_posts"), orderBy("createdAt", "asc"));
    onSnapshot(channelQuery, (snapshot) => {
        const dataArr = [];
        snapshot.forEach(docSnap => {
            dataArr.push({ id: docSnap.id, ...docSnap.data() });
        });

        const prevCount = livePosts.length;
        livePosts = dataArr;

        if (chatBody && livePosts.length === 0) {
            chatBody.innerHTML = `
                <div class="empty-loading" style="padding: 40px 20px; text-align: center; color: #94a3b8;">
                    <i class="fas fa-bullhorn" style="font-size: 28px; margin-bottom: 10px; color: #64748b;"></i>
                    <p style="font-size: 14px; margin: 0;">No updates yet. Check back soon!</p>
                </div>`;
            return;
        }

        const notiPanel = document.getElementById('noti-panel');
        const isNotiPanelOpen = notiPanel && notiPanel.classList.contains('active');
        const blinkDot = document.querySelector('.blink-dot');
        const hasTargetPost = window.location.hash.includes("post/") || new URLSearchParams(window.location.search).has("post");

        if (isInitialChannelLoad) {
            renderChannelFeed(livePosts, !hasTargetPost);
            isInitialChannelLoad = false;
            checkAndOpenTargetPost();
        } else if (livePosts.length !== prevCount) {
            if (!isNotiPanelOpen && blinkDot && livePosts.length > prevCount) {
                blinkDot.style.display = 'block';
            }

            const distanceFromBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight;
            if (distanceFromBottom > 140 && livePosts.length > prevCount) {
                unreadPostsCount += (livePosts.length - prevCount);
                if (unreadBadge) {
                    unreadBadge.innerText = unreadPostsCount > 99 ? '99+' : unreadPostsCount;
                    unreadBadge.classList.add('active');
                }
                if (scrollDownWrapper) scrollDownWrapper.classList.add('show');
                renderChannelFeed(livePosts, false);
            } else {
                renderChannelFeed(livePosts, !hasTargetPost);
            }
        } else {
            livePosts.forEach(p => updateReactionInDOM(p.id));
        }
    }, (error) => {
        if (chatBody) {
            chatBody.innerHTML = `
                <div class="empty-loading" style="padding: 40px 20px; text-align: center; color: #94a3b8;">
                    <i class="fas fa-circle-exclamation" style="font-size: 28px; margin-bottom: 10px; color: #ef4444;"></i>
                    <p style="font-size: 14px; margin: 0;">Updates unavailable.</p>
                </div>`;
        }
    });

    // Books & Metadata loader
    await loadInitialBooksBatch();
    fetchGlobalFilterMetadata();
});
