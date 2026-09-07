import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { 
    getFirestore, collection, addDoc, doc, updateDoc, onSnapshot, 
    query, orderBy, setDoc, getDoc, increment, getDocs, runTransaction, Timestamp, limit 
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { 
    getAuth, signInWithEmailAndPassword, GoogleAuthProvider, 
    signInWithPopup, onAuthStateChanged, signOut 
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-analytics.js";

// ==========================================
// 1. FIREBASE CONFIGURATION
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyASYcouPGDMx5_V9ZUZ3RcFifCxcbpcst8",
  authDomain: "spidy-book-dbe32.firebaseapp.com",
  projectId: "spidy-book-dbe32",
  storageBucket: "spidy-book-dbe32.firebasestorage.app",
  messagingSenderId: "681583149252",
  appId: "1:681583149252:web:f679d1847cd749d0a7c991",
  measurementId: "G-DKH77K3KEH"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const analytics = getAnalytics(app); 

// ==========================================
// 2. SECURE CLOUDFLARE PROXY BASE URL
// ==========================================
const PROXY_STREAM_URL = "https://spidy-proxy.spidybookhub-backend.workers.dev/stream?file="; 

function getSecureAssetUrl(fileKeyOrUrl) {
    if (!fileKeyOrUrl) return DEFAULT_AVATAR;
    if (fileKeyOrUrl.startsWith("http://") || fileKeyOrUrl.startsWith("https://")) {
        return fileKeyOrUrl;
    }
    const cleanKey = fileKeyOrUrl.replace(/^\/+/, '');
    return `${PROXY_STREAM_URL}${cleanKey}`;
}

// ==========================================
// GLOBAL VARIABLES
// ==========================================
let booksData = [];
let mainFilteredData = []; 
let loadedCount = 0; 
let isLoadingMore = false;
let activeBookSlug = ""; 
let activeBookTitle = "";

let IS_SUPER_ADMIN = false;
let isUserLoggedIn = false; 

const DEFAULT_AVATAR = "https://i.postimg.cc/D0BF1b77/file-000000000e847207a64f6711d825a859.png";
let CURRENT_ADMIN_NAME = "Guest User";
let CURRENT_ADMIN_EMAIL = "";
let CURRENT_ADMIN_PHOTO = DEFAULT_AVATAR;

let savedBooks = JSON.parse(localStorage.getItem('spidy_saved_books')) || [];
let selectedCoverFile = null;
let selectedPdfFile = null;
let detectedTotalPages = 0;
let detectedFileSizeMB = "0 MB";

// CHANNEL NOTIFICATIONS STATE
let livePosts = [];
let activePost = null;
let isInitialChannelLoad = true;
let unreadPostsCount = 0;
let isChannelDataReady = false;

// PDF ENGINE & SCROLLER STATE
let currentPdfDocument = null;
let pdfTotalPagesCount = 0;
let pdfTextCache = [];
let searchMatches = [];
let currentSearchMatchIndex = -1;

// ==========================================
// HELPER FUNCTIONS & SANITIZATION
// ==========================================
function sanitizeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, function(match) {
        const escape = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
        return escape[match];
    });
}

function getHighQualityAvatar(url) {
    if (!url) return DEFAULT_AVATAR;
    if (url.includes('googleusercontent.com')) {
        return url.replace(/=s\d+(-c)?/g, '=s400-c');
    }
    return url;
}

function formatNameSerifSmallCaps(nameStr) {
    if (!nameStr) return "";
    const words = nameStr.trim().split(/\s+/);
    return words.map(word => {
        if (word.length === 0) return "";
        const firstLetter = word.charAt(0).toUpperCase();
        const restLetters = word.slice(1).toLowerCase();
        return `<span style="display:inline-flex;align-items:baseline;margin:0 5px 0 0;letter-spacing:0;"><span style="font-family:'Times New Roman',Times,serif;font-weight:900;font-size:1.18em;line-height:1;margin:0;padding:0;">${firstLetter}</span><span style="font-family:'Times New Roman',Times,serif;font-variant:small-caps;font-weight:700;font-size:0.95em;letter-spacing:0.8px;line-height:1;margin:0;padding:0;">${restLetters}</span></span>`;
    }).join('');
}

function stripMarkdown(text) {
    if (!text) return "";
    return text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_~`>]/g, '')
        .replace(/\n+/g, ' ')
        .trim();
}

function parseMarkdown(rawText) {
    if (!rawText) return "";
    let safe = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawText) : sanitizeHTML(rawText);

    safe = safe.replace(/(^|\n)(&gt;|>)\s*(.+?)(?=(\n\n|\n(?!&gt;|>)|$))/gs, function(match, prefix, qTag, content) {
        let cleanContent = content.replace(/(^|\n)(&gt;|>)\s*/g, '$1');
        return prefix + `<div class="wa-markdown-quote">${cleanContent}</div>`;
    });

    safe = safe.replace(/\*([^\*]+)\*/g, '<b>$1</b>');
    safe = safe.replace(/_([^_]+)_/g, '<i>$1</i>');
    safe = safe.replace(/~([^~]+)~/g, '<del>$1</del>');
    safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return safe.replace(/\n/g, '<br>');
}

function formatReactionCount(num) {
    if (!num || num <= 0) return '0';
    if (num >= 1000000) {
        let formatted = (num / 1000000).toFixed(1);
        return (formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted) + 'M';
    }
    if (num >= 1000) {
        let formatted = (num / 1000).toFixed(1);
        return (formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted) + 'K';
    }
    return num.toString();
}

function formatViewsCount(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

function normalizeDate(timestamp) {
    if (!timestamp) return new Date();
    if (timestamp instanceof Timestamp) return timestamp.toDate();
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    return new Date(timestamp);
}

function formatDateDivider(dateObj) {
    return dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(dateObj) {
    return dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ==========================================
// TOAST NOTIFICATIONS (SAFE HEIGHT ABOVE BOTTOM NAV)
// ==========================================
let globalToastTimeout;
function showToast(message, type = 'success') {
    const toast = document.getElementById('customToast');
    if(!toast) return; 
    
    clearTimeout(globalToastTimeout);
    
    toast.style.position = "fixed";
    toast.style.bottom = "82px"; 
    toast.style.right = "16px";
    toast.style.left = "auto";
    toast.style.maxWidth = "88vw";
    toast.style.zIndex = "999999999";
    toast.style.transition = "transform 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease";
    toast.style.borderRadius = "14px";
    toast.style.padding = "12px 18px";
    toast.style.backdropFilter = "blur(12px)";
    toast.style.background = "rgba(18, 18, 22, 0.96)";

    if (type === 'success') {
        toast.innerHTML = `<i class="fas fa-circle-check" style="color: #10b981; font-size: 16px;"></i> <span style="color:#ffffff; font-weight:700;">${sanitizeHTML(message)}</span>`;
        toast.style.border = "1px solid rgba(16, 185, 129, 0.4)";
        toast.style.borderLeft = "4px solid #10b981";
        toast.style.boxShadow = "inset 0 0 25px rgba(16, 185, 129, 0.25), 0 10px 30px rgba(0,0,0,0.85)";
    } else {
        toast.innerHTML = `<i class="fas fa-circle-exclamation" style="color: #ef4444; font-size: 16px;"></i> <span style="color:#ffffff; font-weight:700;">${sanitizeHTML(message)}</span>`;
        toast.style.border = "1px solid rgba(239, 68, 68, 0.4)";
        toast.style.borderLeft = "4px solid #ef4444";
        toast.style.boxShadow = "inset 0 0 25px rgba(239, 68, 68, 0.25), 0 10px 30px rgba(0,0,0,0.85)";
    }

    toast.style.transform = "translateX(120%)";
    toast.style.opacity = "0";
    toast.style.display = "flex";
    void toast.offsetWidth; 
    
    toast.style.transform = "translateX(0)";
    toast.style.opacity = "1";

    globalToastTimeout = setTimeout(() => {
        toast.style.transform = "translateX(120%)";
        toast.style.opacity = "0";
    }, 2500);
}

function generateDeviceFingerprint() {
    const nav = window.navigator;
    const screen = window.screen;
    const str = nav.userAgent + nav.language + screen.colorDepth + screen.width + screen.height + new Date().getTimezoneOffset();
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        let char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}

function initParticles(containerId) {
    const container = document.getElementById(containerId);
    if (!container || container.hasChildNodes()) return;
    for (let i = 0; i < 35; i++) {
        let particle = document.createElement('div');
        particle.classList.add('particle');
        let size = Math.random() * 2.2 + 1.8; 
        let posX = Math.random() * 100; 
        let delay = Math.random() * 12; 
        let duration = Math.random() * 10 + 8; 
        particle.style.width = size + 'px'; 
        particle.style.height = size + 'px';
        particle.style.left = posX + '%'; 
        particle.style.animationDelay = `-${delay}s`;
        particle.style.animationDuration = duration + 's';
        container.appendChild(particle);
    }
}

function cleanUnicodeTextForSearch(str) {
    if (!str) return "";
    return str
        .normalize("NFD")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[^\p{L}\p{M}\p{N}]/gu, "")
        .toLowerCase();
}

// ACTIVE TIME SPENT HEARTBEAT
setInterval(async () => {
    if (document.visibilityState === 'visible' && auth.currentUser) {
        try {
            const token = await auth.currentUser.getIdToken(false);
            await fetch('/api/track-time', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userToken: token })
            });
        } catch (e) {
            console.warn("Time sync skipped:", e);
        }
    }
}, 60000);

// ==========================================
// PROMO CAROUSEL LOGIC
// ==========================================
let currentPromoIndex = 0;
let promoAutoSlideInterval;

function initPromoCarousel() {
    const track = document.getElementById('promoCarouselTrack');
    const dots = document.querySelectorAll('.promo-dot');
    const prevBtn = document.getElementById('promoPrevBtn');
    const nextBtn = document.getElementById('promoNextBtn');
    const totalSlides = dots.length;

    if (!track || totalSlides === 0) return;

    function goToSlide(index) {
        currentPromoIndex = index;
        track.style.transform = `translateX(-${currentPromoIndex * 100}%)`;
        dots.forEach((dot, idx) => {
            if (idx === currentPromoIndex) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
    }

    function startAutoSlide() {
        clearInterval(promoAutoSlideInterval);
        promoAutoSlideInterval = setInterval(() => {
            currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
            goToSlide(currentPromoIndex);
        }, 4000);
    }

    dots.forEach((dot, index) => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            goToSlide(index);
            startAutoSlide();
        });
    });

    if (prevBtn) {
        prevBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            goToSlide(currentPromoIndex);
            startAutoSlide();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
            goToSlide(currentPromoIndex);
            startAutoSlide();
        });
    }

    let startX = 0;
    let endX = 0;
    track.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        clearInterval(promoAutoSlideInterval);
    }, { passive: true });

    track.addEventListener('touchend', (e) => {
        endX = e.changedTouches[0].clientX;
        let diff = startX - endX;
        if (Math.abs(diff) > 40) {
            if (diff > 0) {
                currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
            } else {
                currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            }
            goToSlide(currentPromoIndex);
        }
        startAutoSlide();
    }, { passive: true });

    goToSlide(0);
    startAutoSlide();
}

// ==========================================
// POPUPS LOGIC (Telegram 1m, WhatsApp 5m)
// ==========================================
let popupsInitialized = false;
function initPremiumPopups() {
    if(popupsInitialized) return; 
    popupsInitialized = true;

    const telegramPopup = document.getElementById('telegramPopup');
    const whatsappPopup = document.getElementById('whatsappPopup');
    const tgMaybeLaterBtn = document.getElementById('tgMaybeLaterBtn');
    const waMaybeLaterBtn = document.getElementById('waMaybeLaterBtn');

    const closeTgPopup = () => { if(telegramPopup) telegramPopup.classList.add('hide'); };
    const closeWaPopup = () => { if(whatsappPopup) whatsappPopup.classList.add('hide'); };

    if(tgMaybeLaterBtn) tgMaybeLaterBtn.addEventListener('click', closeTgPopup);
    if(waMaybeLaterBtn) waMaybeLaterBtn.addEventListener('click', closeWaPopup);

    setTimeout(() => {
        if(telegramPopup) telegramPopup.classList.remove('hide');
    }, 60000); 

    setTimeout(() => {
        if(telegramPopup) telegramPopup.classList.add('hide'); 
        if(whatsappPopup) whatsappPopup.classList.remove('hide');
    }, 300000); 
}

// ==========================================
// UPLOAD TUTORIAL POPUP (1 HOUR RATE LIMIT)
// ==========================================
function checkAndShowUploadTutorialPopup() {
    const uploadPopup = document.getElementById('uploadPopup');
    if (!uploadPopup) return;

    const lastShown = localStorage.getItem('spidy_last_upload_popup_time');
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    if (!lastShown || (now - parseInt(lastShown, 10)) >= ONE_HOUR) {
        uploadPopup.classList.remove('hidden');
        localStorage.setItem('spidy_last_upload_popup_time', now.toString());
    }
}

// ==========================================
// INITIAL LOADER & DEEP LINKING
// ==========================================
const urlParamsCheck = new URLSearchParams(window.location.search);
let isDeepLinkLoad = urlParamsCheck.has('book'); 
let pendingBookSlug = urlParamsCheck.get('book');

if (isDeepLinkLoad) {
    document.getElementById('mainAppWrapper').style.display = 'none';
    document.getElementById('downloadModal').style.display = 'none';
}

let isAppReady = { auth: false, data: false }; 
let hasTransitioned = false;
let loadingProgress = 0;
let loaderInterval;

function updateLoaderUI(percent) {
    const loaderFill = document.getElementById('loaderFill');
    const loaderPercentage = document.getElementById('loaderPercentage');
    const loaderStatusText = document.getElementById('loaderStatusText');
    if (loaderFill) loaderFill.style.width = percent + "%";
    if (loaderPercentage) loaderPercentage.innerText = percent + "%";
    if (loaderStatusText) {
        if (percent < 30) loaderStatusText.innerText = "Initializing System...";
        else if (percent < 60) loaderStatusText.innerText = "Fetching Secure Data...";
        else if (percent < 95) loaderStatusText.innerText = "Preparing Content...";
        else loaderStatusText.innerText = "Ready to Launch!";
    }
}

loaderInterval = setInterval(() => {
    if (loadingProgress < 85) {
        loadingProgress += Math.floor(Math.random() * 5) + 2; 
        if (loadingProgress > 85) loadingProgress = 85;
        updateLoaderUI(loadingProgress);
    }
}, 200);

function tryTransition() {
    if (isAppReady.auth && isAppReady.data && !hasTransitioned) {
        hasTransitioned = true;
        clearInterval(loaderInterval); 
        
        let fastLoad = setInterval(() => {
            loadingProgress += 4;
            if(loadingProgress >= 100) {
                loadingProgress = 100;
                updateLoaderUI(100);
                clearInterval(fastLoad);

                setTimeout(() => {
                    document.getElementById('mainAppWrapper').style.display = 'block';
                    initPromoCarousel();

                    if (isDeepLinkLoad && pendingBookSlug) {
                        if (isUserLoggedIn) { openDownloadPageLocal(pendingBookSlug, true); } 
                        else {
                            const loginOverlay = document.getElementById('loginOverlay');
                            loginOverlay.style.display = 'flex';
                            setTimeout(() => loginOverlay.style.opacity = '1', 10);
                        }
                    } else {
                        initPremiumPopups(); 
                    }
                    const loader = document.getElementById("loaderScreen");
                    loader.style.opacity = "0"; 
                    setTimeout(() => { loader.style.display = "none"; }, 300);
                }, 400); 
            } else {
                updateLoaderUI(loadingProgress);
            }
        }, 15);
    }
}

// ==========================================
// CREDITS & RANKING SYSTEM
// ==========================================
function updateLiveCredits(remainingCount) {
    if (IS_SUPER_ADMIN) {
        document.getElementById('profile-credits').innerHTML = `<span style="font-size: 24px;">&infin;</span>`; 
        return;
    }
    const safeCount = Math.max(0, remainingCount !== undefined ? remainingCount : 0);
    document.getElementById('profile-credits').innerText = safeCount;
}

function syncAndSanitizeBookmarks() {
    if (!booksData || booksData.length === 0) return;
    const existingSlugs = new Set(booksData.map(b => b.slug));
    savedBooks = savedBooks.filter(slug => existingSlugs.has(slug));
    localStorage.setItem('spidy_saved_books', JSON.stringify(savedBooks));
    const savedCountEl = document.getElementById('profile-saved');
    if (savedCountEl) savedCountEl.innerText = savedBooks.length;
}

async function syncProfileAndRankUI() {
    if (!auth.currentUser) return;
    
    const formattedNameHTML = formatNameSerifSmallCaps(CURRENT_ADMIN_NAME);
    const profileNameEl = document.getElementById('profile-name-ui');
    if (profileNameEl) profileNameEl.innerHTML = formattedNameHTML;
    
    const emailEl = document.getElementById('profile-email-ui');
    if (emailEl) {
        emailEl.innerText = auth.currentUser.email || "No Email linked";
        emailEl.style.fontWeight = "600";
    }
    
    const avatarEl = document.getElementById('profile-avatar-ui');
    if (avatarEl) {
        avatarEl.src = CURRENT_ADMIN_PHOTO;
        avatarEl.onerror = () => { avatarEl.src = DEFAULT_AVATAR; };
    }
    
    syncAndSanitizeBookmarks();

    try {
        const userRef = doc(db, "users", auth.currentUser.uid);
        const userSnap = await getDoc(userRef);
        
        if (userSnap.exists()) {
            const data = userSnap.data();
            const now = Date.now();
            const validDownloads = (data.recentDownloads || []).filter(item => {
                const time = typeof item === 'number' ? item : item.time;
                return (now - time) < 24 * 60 * 60 * 1000;
            });
            
            const uniqueSlugs = new Set(validDownloads.map(i => i.slug).filter(Boolean));
            const remaining = Math.max(0, 20 - uniqueSlugs.size);
            updateLiveCredits(remaining);

            document.getElementById('profile-downloads').innerText = data.lifetimeDownloads || 0;
        }

        const userToken = await auth.currentUser.getIdToken(false);
        const rankRes = await fetch('/api/get-rank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userToken })
        });
        
        const rankData = await rankRes.json();
        const rankElement = document.getElementById('profile-rank');

        if (rankElement && rankData.success) {
            const rank = rankData.rank;
            if (rank === 1) {
                rankElement.style.color = "#fbbf24";
                rankElement.innerHTML = `<i class="fas fa-crown"></i> #1`;
            } else if (rank <= 3) {
                rankElement.style.color = rank === 2 ? "#9ca3af" : "#b45309";
                rankElement.innerText = "#" + rank;
            } else if (rank === '1K+' || rank > 1000) {
                rankElement.style.color = "#ffffff";
                rankElement.innerText = "#1K+";
            } else {
                rankElement.style.color = "#ffffff";
                rankElement.innerText = "#" + rank;
            }
        }
    } catch (error) {
        console.error("Profile rank sync error:", error);
    }
}

// ==========================================
// CHANNEL UPDATES & NOTIFICATIONS
// ==========================================
const chatBody = document.getElementById('chatBody');
const contextOverlay = document.getElementById('contextOverlay');
const scrollDownWrapper = document.getElementById('scrollDownWrapper');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const unreadBadge = document.getElementById('unreadBadge');
const closeNotiBtn = document.getElementById('close-noti-btn');

if (chatBody) {
    chatBody.style.willChange = 'transform, scroll-position';
    chatBody.style.transform = 'translateZ(0)';
}

function renderChannelLoader() {
    if (!chatBody) return;
    chatBody.innerHTML = `
        <div class="empty-loading" id="channelLoader" style="opacity: 1; transition: opacity 0.3s ease;">
            <div class="orbit-spinner">
                <div class="orbit-ring"></div>
                <div class="orbit-inner-ring"></div>
                <div class="orbit-core"></div>
            </div>
            Connecting to live updates...
        </div>`;
}

function getUserReaction(postId) {
    return localStorage.getItem(`reaction_${postId}`);
}

function setUserReaction(postId, emoji) {
    if (emoji) localStorage.setItem(`reaction_${postId}`, emoji);
    else localStorage.removeItem(`reaction_${postId}`);
}

function scrollToBottomInstant() {
    unreadPostsCount = 0;
    if (unreadBadge) {
        unreadBadge.innerText = '0';
        unreadBadge.classList.remove('active');
    }
    chatBody.scrollTop = chatBody.scrollHeight;
}

function scrollToBottomSmooth() {
    unreadPostsCount = 0;
    if (unreadBadge) {
        unreadBadge.innerText = '0';
        unreadBadge.classList.remove('active');
    }
    chatBody.scrollTo({
        top: chatBody.scrollHeight,
        behavior: 'smooth'
    });
}

if (scrollDownBtn) {
    scrollDownBtn.addEventListener('click', scrollToBottomSmooth);
}

if (chatBody) {
    chatBody.addEventListener('scroll', () => {
        const distanceFromBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight;
        if (distanceFromBottom > 120) {
            scrollDownWrapper.classList.add('show');
        } else {
            scrollDownWrapper.classList.remove('show');
            unreadPostsCount = 0;
            unreadBadge.innerText = '0';
            unreadBadge.classList.remove('active');
        }
    }, { passive: true });
}

window.scrollToChannelPost = function(postId) {
    if (!postId) return;
    const target = document.getElementById(`post_${postId}`);
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('highlight-post');
        setTimeout(() => target.classList.remove('highlight-post'), 1800);
    } else {
        showToast("Original message was deleted or moved.", "error");
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
            <div class="reaction-pill ${isActive}" data-emoji="${emoji}" style="transition: transform 0.15s ease;">
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
                applyReaction(postId, pill.dataset.emoji);
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
    } catch (err) {
        console.warn("View tracker ping skipped:", err);
    }
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
        isChannelDataReady = true;
        return;
    }

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
        bubble.style.transform = "none";

        let imageHTML = post.imageUrl 
            ? `<img src="${sanitizeHTML(post.imageUrl)}" loading="lazy" class="msg-image" alt="Post Image">` 
            : '';

        let quoteHTML = '';
        if (post.quote) {
            const targetId = post.quote.targetPostId || '';
            const cleanAuthor = 'SPIDY BOOK HUB';
            const cleanSnippet = sanitizeHTML(stripMarkdown(post.quote.text || ''));
            quoteHTML = `
            <div class="msg-quote" onclick="event.stopPropagation(); window.scrollToChannelPost('${targetId}')">
                 <div class="quote-author">${cleanAuthor}</div>
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
            if (e.target.tagName === 'A') return;
            activePost = post;
            if (contextOverlay) contextOverlay.classList.add('show');
            if (navigator.vibrate) navigator.vibrate(20);
        });

        fragment.appendChild(bubble);
        postViewObserver.observe(bubble);
    });

    if (isInitialOrPanelOpen) {
        chatBody.style.visibility = 'hidden';
        chatBody.innerHTML = '';
        chatBody.appendChild(fragment);
        chatBody.scrollTop = chatBody.scrollHeight;
        
        requestAnimationFrame(() => {
            chatBody.scrollTop = chatBody.scrollHeight;
            chatBody.style.visibility = 'visible';
            isChannelDataReady = true;
        });
    } else {
        const prevScrollTop = chatBody.scrollTop;
        chatBody.innerHTML = '';
        chatBody.appendChild(fragment);
        chatBody.scrollTop = prevScrollTop;
    }
}

async function applyReaction(postId, newEmoji) {
    if (!auth.currentUser) {
        showToast("Please login to react!", "error");
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
        await fetch('/api/channel-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'reaction', postId, emoji: newEmoji, userToken: token })
        });
    } catch (e) {
        console.warn("Reaction background sync error:", e);
    }
}

// CONTEXT MENU LISTENERS
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
        showToast("Text Copied!", "success");
        contextOverlay.classList.remove('show');
    });

    document.getElementById('cmCopyLink')?.addEventListener('click', () => {
        if (!activePost) return;
        const url = `${window.location.origin}${window.location.pathname}#/post/${activePost.id}`;
        navigator.clipboard.writeText(url);
        showToast("Link Copied!", "success");
        contextOverlay.classList.remove('show');
    });

    document.getElementById('cmForward')?.addEventListener('click', () => {
        if (!activePost) return;
        const url = `${window.location.origin}${window.location.pathname}#/post/${activePost.id}`;
        const cleanText = stripMarkdown(activePost.text);
        if (navigator.share) {
            navigator.share({ title: 'SPIDY BOOK HUB', text: cleanText, url: url }).catch(() => {});
        } else {
            navigator.clipboard.writeText(url);
            showToast("Link Copied for Share!", "success");
        }
        contextOverlay.classList.remove('show');
    });

    document.getElementById('cmReport')?.addEventListener('click', () => {
        showToast("Post reported successfully!", "success");
        contextOverlay.classList.remove('show');
    });
}

// ==========================================
// AUTHENTICATION OBSERVER
// ==========================================
onAuthStateChanged(auth, async (user) => {
    if (user) {
        isUserLoggedIn = true;
        localStorage.setItem('isUserLoggedIn', 'true');

        let dName = user.displayName || user.email.split('@')[0];
        document.getElementById('sidebarProfileName').innerText = sanitizeHTML(dName);
        
        CURRENT_ADMIN_PHOTO = getHighQualityAvatar(user.photoURL);
        const sidebarAvatar = document.getElementById('sidebarProfileImg');
        if (sidebarAvatar) {
            sidebarAvatar.src = CURRENT_ADMIN_PHOTO;
            sidebarAvatar.onerror = () => { sidebarAvatar.src = DEFAULT_AVATAR; };
        }
        
        CURRENT_ADMIN_NAME = dName;
        CURRENT_ADMIN_EMAIL = user.email;

        try {
            const userRef = doc(db, "users", user.uid);
            const userSnap = await getDoc(userRef);
            
            const cleanEmail = user.email ? user.email.toLowerCase().trim() : "";
            const adminDocRef = doc(db, "admins", cleanEmail);
            const adminDocSnap = await getDoc(adminDocRef);

            if (adminDocSnap.exists()) {
                IS_SUPER_ADMIN = true;
                document.getElementById('sidebarRoleText').innerText = "Super Admin";
            } else {
                IS_SUPER_ADMIN = false;
                document.getElementById('sidebarRoleText').innerText = "Verified User";
                switchAdminTabLocal('add');
            }

            if (!userSnap.exists()) {
                await setDoc(userRef, { 
                    email: user.email, 
                    name: dName, 
                    photo: CURRENT_ADMIN_PHOTO, 
                    recentDownloads: [], 
                    lifetimeDownloads: 0, 
                    timeSpentSeconds: 0,
                    createdAt: new Date().getTime() 
                }, { merge: true });
                updateLiveCredits(20); 
            }

            syncProfileAndRankUI();

            document.querySelectorAll('.message-bubble').forEach(bubble => {
                if (bubble.dataset.postId) registerUniqueView(bubble.dataset.postId);
            });

        } catch (error) { 
            console.error("Verification failed:", error); 
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

        const profileNameEl = document.getElementById('profile-name-ui');
        if (profileNameEl) profileNameEl.innerHTML = formatNameSerifSmallCaps("Guest User");

        const emailEl = document.getElementById('profile-email-ui');
        if (emailEl) {
            emailEl.innerText = "Please login to sync progress";
            emailEl.style.fontWeight = "600";
        }
        const avatarEl = document.getElementById('profile-avatar-ui');
        if (avatarEl) avatarEl.src = DEFAULT_AVATAR;

        document.getElementById('profile-credits').innerText = "--";
        document.getElementById('profile-downloads').innerText = "0";
        document.getElementById('profile-saved').innerText = "0";
        document.getElementById('profile-rank').innerText = "#--";
    }

    isAppReady.auth = true; 
    tryTransition();

    onSnapshot(query(collection(db, "prompts"), orderBy("createdAt", "asc")), (snapshot) => {
        const container = document.getElementById('promptsContainer');
        if(!container) return;
        container.innerHTML = '';
        if(snapshot.empty) { 
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#a1a1aa; font-weight:800;">No prompts available yet.</div>`; 
            return; 
        }
        snapshot.forEach(docSnap => {
            const data = docSnap.data(); 
            const id = docSnap.id;
            const safeText = sanitizeHTML(data.text);
            const safeInstruction = data.instruction ? sanitizeHTML(data.instruction).replace(/\n/g, "<br>") : "";
            const safeTitle = sanitizeHTML(data.title);
            let instructionHTML = '';
            if(safeInstruction) { 
                instructionHTML = `<div style="color: #ffffff; font-weight: 600; font-size: 14px; margin-bottom: 8px; margin-left: 2px; line-height: 1.5; font-family: 'Inter', sans-serif;">${safeInstruction}</div>`; 
            }
            container.innerHTML += `<div class="telegram-prompt-wrapper">${instructionHTML}<div class="telegram-prompt-card"><div class="telegram-prompt-header" style="display:flex; align-items:center;">${safeTitle}</div><div class="telegram-prompt-body">${safeText}</div><div class="telegram-prompt-footer"><button class="telegram-copy-btn" data-text="${encodeURIComponent(data.text)}" id="copy-btn-${id}"><i class="far fa-copy"></i> COPY CODE</button></div></div></div>`;
        });
    });

    const q = query(collection(db, "books"), orderBy("createdAt", "desc"));
    onSnapshot(q, (snapshot) => {
        booksData = [];
        snapshot.forEach((docSnap) => {
            let data = docSnap.data(); 
            data.id = docSnap.id;
            data.slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
            booksData.push(data);
        });
        mainFilteredData = [...booksData]; 
        syncAndSanitizeBookmarks();
        renderStaticFilterPills(); 
        applyMasterFilter(); 
        
        isAppReady.data = true; 
        tryTransition();
    });

    renderChannelLoader();
    const channelQuery = query(collection(db, "channel_posts"), orderBy("createdAt", "asc"));
    onSnapshot(channelQuery, (snapshot) => {
        const dataArr = [];
        snapshot.forEach(docSnap => {
            dataArr.push({ id: docSnap.id, ...docSnap.data() });
        });

        const prevCount = livePosts.length;
        livePosts = dataArr;

        const notiPanel = document.getElementById('noti-panel');
        const isNotiPanelOpen = notiPanel && notiPanel.classList.contains('active');
        const blinkDot = document.querySelector('.blink-dot');

        if (isInitialChannelLoad) {
            renderChannelFeed(livePosts, true);
            isInitialChannelLoad = false;
        } else if (livePosts.length !== prevCount) {
            if (!isNotiPanelOpen && blinkDot && livePosts.length > prevCount) {
                blinkDot.style.display = 'block';
            }

            const distanceFromBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight;
            
            if (distanceFromBottom > 120 && livePosts.length > prevCount) {
                unreadPostsCount += (livePosts.length - prevCount);
                unreadBadge.innerText = unreadPostsCount > 99 ? '99+' : unreadPostsCount;
                unreadBadge.classList.add('active');
                scrollDownWrapper.classList.add('show');
                renderChannelFeed(livePosts, false);
            } else {
                renderChannelFeed(livePosts, true);
            }
        } else {
            livePosts.forEach(p => updateReactionInDOM(p.id));
        }
    }, (error) => {
        console.error("Firestore Channel error:", error);
        if (chatBody) {
            chatBody.innerHTML = `<div class="empty-loading" style="color:#ef4444;"><i class="fas fa-triangle-exclamation" style="font-size:24px;"></i>Failed to load channel updates.</div>`;
        }
    });
});

// PROMPTS COPY HANDLER
document.getElementById('promptsContainer')?.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.telegram-copy-btn');
    if (copyBtn) {
        const textToCopy = decodeURIComponent(copyBtn.getAttribute('data-text'));
        navigator.clipboard.writeText(textToCopy).then(() => {
            const originalHtml = copyBtn.innerHTML;
            copyBtn.innerHTML = '<i class="fas fa-check"></i> COPIED!';
            copyBtn.style.background = 'rgba(16, 185, 129, 0.2)';
            copyBtn.style.color = '#10b981';
            copyBtn.style.border = '1px solid rgba(16, 185, 129, 0.4)';
            setTimeout(() => {
                copyBtn.innerHTML = originalHtml;
                copyBtn.style.background = 'transparent';
                copyBtn.style.color = '#ffffff';
                copyBtn.style.border = 'none';
            }, 2000);
        }).catch(() => { showToast("Failed to copy text!", "error"); });
    }
});

// ==========================================
// LOGIN & LOGOUT SYSTEM
// ==========================================
function closeLoginOverlayLocal() {
    const loginOverlay = document.getElementById('loginOverlay');
    loginOverlay.style.opacity = '0';
    setTimeout(() => { 
        loginOverlay.style.display = 'none'; 
        if (isDeepLinkLoad && !isUserLoggedIn) {
            isDeepLinkLoad = false;
            window.history.replaceState({}, '', window.location.pathname);
            initPremiumPopups(); 
        }
    }, 500);
}
document.getElementById('closeLoginBtn').addEventListener('click', closeLoginOverlayLocal);
document.getElementById('toggleEye').addEventListener('click', () => {
    const passInput = document.getElementById('loginPassword'); 
    const eyeIcon = document.getElementById('toggleEye');
    if (passInput.type === 'password') { 
        passInput.type = 'text'; 
        eyeIcon.classList.replace('fa-eye', 'fa-eye-slash'); 
        eyeIcon.style.color = '#00d2ff'; 
    } else { 
        passInput.type = 'password'; 
        eyeIcon.classList.replace('fa-eye-slash', 'fa-eye'); 
        eyeIcon.style.color = '#a1a1aa'; 
    }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); 
    const email = document.getElementById('loginEmail').value; 
    const pass = document.getElementById('loginPassword').value;
    const btn = document.getElementById('loginBtn'); 
    const originalContent = btn.innerHTML;
    btn.innerHTML = `<span style="display:flex; align-items:center; gap:8px;"><i class="fas fa-spinner fa-spin"></i> Authenticating...</span>`;
    try { 
        await signInWithEmailAndPassword(auth, email, pass); 
        e.target.reset(); 
        showToast("Login Successful!", "success"); 
        btn.innerHTML = originalContent; 
        closeLoginOverlayLocal();
        if (isDeepLinkLoad && pendingBookSlug) {
            document.getElementById('mainAppWrapper').style.display = 'block';
            setTimeout(() => { openDownloadPageLocal(pendingBookSlug, true); }, 300);
        }
    } catch(err) { 
        showToast("Failed: Invalid Credentials!", "error"); 
        btn.innerHTML = originalContent; 
    } 
});

document.getElementById('googleSignInBtn').addEventListener('click', async () => { 
    const btn = document.getElementById('googleSignInBtn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = `<span style="display:flex; align-items:center; gap:8px;"><i class="fas fa-spinner fa-spin"></i> Connecting...</span>`;
    try { 
        await signInWithPopup(auth, provider); 
        showToast("Google Login Successful!", "success"); 
        btn.innerHTML = originalContent; 
        closeLoginOverlayLocal();
        if (isDeepLinkLoad && pendingBookSlug) {
            document.getElementById('mainAppWrapper').style.display = 'block';
            setTimeout(() => { openDownloadPageLocal(pendingBookSlug, true); }, 300);
        }
    } catch(err) { 
        showToast("Failed: Google Sign-In Error.", "error"); 
        btn.innerHTML = originalContent; 
    } 
});

const logoutBtn = document.getElementById('admin-logout-btn');
const logoutOverlay = document.getElementById('customLogoutOverlay');
const cancelLogoutBtn = document.getElementById('cancelLogoutBtn');
const confirmLogoutBtn = document.getElementById('confirmLogoutBtn');

if (logoutBtn) logoutBtn.addEventListener('click', () => { 
    if (logoutOverlay) { 
        logoutOverlay.style.display = 'flex'; 
        setTimeout(() => logoutOverlay.classList.add('show'), 10); 
    } 
});
if (cancelLogoutBtn) cancelLogoutBtn.addEventListener('click', () => { 
    if (logoutOverlay) { 
        logoutOverlay.classList.remove('show'); 
        setTimeout(() => logoutOverlay.style.display = 'none', 300); 
    } 
});
if (confirmLogoutBtn) {
    confirmLogoutBtn.addEventListener('click', async () => {
        confirmLogoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        try {
            await signOut(auth);
            localStorage.removeItem('isUserLoggedIn');
            window.location.reload();
        } catch (error) { 
            showToast("Error signing out!", "error"); 
        }
    });
}

const uploadPopup = document.getElementById('uploadPopup');
const closeUploadPopupBtn = document.getElementById('closeUploadPopupBtn');

if (closeUploadPopupBtn && uploadPopup) {
    closeUploadPopupBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadPopup.classList.add('hidden');
    });
}

// ==========================================
// FILTERS
// ==========================================
const FIXED_EXAM_LIST = [
    "10th", "11th", "12th", "Ssc", "Railway", "Defence", 
    "Banking", "Teaching", "Upsc", "Police", "Jee", "Neet", "General Reading"
];

const EXAM_CATEGORY_MAP = {
    "10th": ["CLASS 10", "CLASS 10TH", "10TH", "MATRIC", "CBSE 10", "ICSE 10", "BOARD 10"],
    "11th": ["CLASS 11", "CLASS 11TH", "11TH", "CBSE 11", "ISC 11"],
    "12th": ["CLASS 12", "CLASS 12TH", "12TH", "INTER", "INTERMEDIATE", "CBSE 12", "ISC 12", "BOARD 12"],
    "Ssc": ["SSC", "CGL", "CHSL", "MTS", "CPO", "GD", "STENOGRAPHER", "SELECTION POST"],
    "Railway": ["RAILWAY", "RRB", "NTPC", "GROUP D", "ALP", "TECHNICIAN", "RPF"],
    "Defence": ["NDA", "CDS", "AFCAT", "NAVY", "ARMY", "AIRFORCE", "AGNIVEER"],
    "Banking": ["BANK", "IBPS", "SBI", "PO", "CLERK", "RBI", "LIC"],
    "Teaching": ["CTET", "STET", "UPTET", "KVS", "NVS", "BPSC TRE", "DSSSB"],
    "Upsc": ["UPSC", "BPSC", "UPPSC", "MPPSC", "STATE PSC", "PCS", "CIVIL SERVICES"],
    "Police": ["POLICE", "UP POLICE", "DELHI POLICE", "BIHAR POLICE", "SI", "CONSTABLE", "DAROGA"],
    "Jee": ["JEE", "IIT", "MAINS", "ADVANCED", "BITSAT"],
    "Neet": ["NEET", "MEDICAL", "AIIMS"],
    "General Reading": ["GENERAL", "NOVEL", "STORY", "MAGAZINE", "SELF HELP", "READING", "HISTORY", "MOTIVATION"]
};

let currentSelectedCategory = "All";
let currentSelectedLanguage = "All";

function renderStaticFilterPills() {
    const catGrid = document.getElementById('categoryFilterGrid'); 
    if(!catGrid) return;
    
    let html = `<div class="f-pill ${currentSelectedCategory === 'All' ? 'active' : ''}" data-category="All">All</div>`;
    FIXED_EXAM_LIST.forEach(category => { 
        html += `<div class="f-pill ${category === currentSelectedCategory ? 'active' : ''}" data-category="${category}">${category}</div>`; 
    });
    catGrid.innerHTML = html;
}

document.getElementById('categoryFilterGrid')?.addEventListener('click', (e) => {
    if(e.target.classList.contains('f-pill')) {
        document.querySelectorAll('#categoryFilterGrid .f-pill').forEach(el => el.classList.remove('active'));
        e.target.classList.add('active'); 
        currentSelectedCategory = e.target.getAttribute('data-category');
    }
});

document.getElementById('languageFilterGrid')?.addEventListener('click', (e) => {
    if(e.target.classList.contains('f-pill')) {
        document.querySelectorAll('#languageFilterGrid .f-pill').forEach(el => el.classList.remove('active'));
        e.target.classList.add('active'); 
        currentSelectedLanguage = e.target.getAttribute('data-lang');
    }
});

document.getElementById('applyFiltersBtn')?.addEventListener('click', () => { 
    document.getElementById('filterBottomOverlay').classList.remove('active'); 
    applyMasterFilter(); 
});

function normalizeTextForSearch(str) {
    if (!str) return '';
    return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function applyMasterFilter() {
    const searchInputRaw = document.getElementById('app-search-input').value.trim();
    const rawLower = searchInputRaw.toLowerCase();
    const cleanSearchNoSpaces = normalizeTextForSearch(searchInputRaw);
    const searchWords = rawLower.split(/\s+/).filter(w => w.length > 0);

    mainFilteredData = booksData.filter(book => {
        let matchesCategory = true;
        if (currentSelectedCategory !== "All") {
            let bookExamsString = (book.exams || "").toUpperCase();
            let keywordsToCheck = EXAM_CATEGORY_MAP[currentSelectedCategory] || [currentSelectedCategory.toUpperCase()];
            matchesCategory = keywordsToCheck.some(keyword => bookExamsString.includes(keyword));
        }

        let matchesLanguage = currentSelectedLanguage === "All" || (book.lang || "").toLowerCase().trim() === currentSelectedLanguage.toLowerCase().trim();

        let matchesSearch = true;
        if (searchInputRaw.length > 0) {
            const rawCombined = `${book.title || ''} ${book.author || ''} ${book.exams || ''}`.toLowerCase();
            const normalizedTarget = normalizeTextForSearch(rawCombined);

            const isNoSpaceMatch = normalizedTarget.includes(cleanSearchNoSpaces);
            const isTokenMatch = searchWords.length > 0 && searchWords.every(word => rawCombined.includes(word));

            matchesSearch = isNoSpaceMatch || isTokenMatch;
        }

        return matchesCategory && matchesLanguage && matchesSearch;
    });
    
    loadedCount = 0; 
    const infiniteLoader = document.getElementById('infinite-loader');
    if(mainFilteredData.length > 0) { 
        document.getElementById('no-results-msg').style.display = 'none'; 
        if(infiniteLoader) infiniteLoader.style.display = mainFilteredData.length > getBatchSize() ? 'flex' : 'none';
        renderBooksUI(0, getBatchSize(), mainFilteredData); 
    } else { 
        document.getElementById("bookContainer").innerHTML = ""; 
        document.getElementById('no-results-msg').style.display = 'flex'; 
        if(infiniteLoader) infiniteLoader.style.display = 'none';
    }
}

const searchInputEl = document.getElementById('app-search-input'); 
let searchTimeout;
searchInputEl.addEventListener('input', () => { 
    clearTimeout(searchTimeout); 
    searchTimeout = setTimeout(() => { applyMasterFilter(); }, 250); 
});
document.getElementById('close-search').addEventListener('click', () => { 
    searchInputEl.value = ''; 
    applyMasterFilter(); 
    document.getElementById('search-box').classList.remove('active'); 
    if (history.state && history.state.popup === 'search') { history.back(); }
});
document.getElementById('openAuthorFilterBtn').addEventListener('click', () => { 
    document.getElementById('filterBottomOverlay').classList.add('active'); 
});
document.getElementById('closeAuthorFilterBtn').addEventListener('click', () => { 
    document.getElementById('filterBottomOverlay').classList.remove('active'); 
});

function getBatchSize() { 
    let w = window.innerWidth; 
    return (w >= 1200 ? 5 : w >= 900 ? 4 : w >= 600 ? 3 : 2) * 4; 
}

const infiniteScrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting && loadedCount < mainFilteredData.length && !isLoadingMore && document.getElementById('no-results-msg').style.display !== 'flex') {
            isLoadingMore = true; 
            if(document.getElementById('infinite-loader')) document.getElementById('infinite-loader').style.display = 'flex';
            setTimeout(() => {
                renderBooksUI(loadedCount, getBatchSize(), mainFilteredData);
                if (loadedCount >= mainFilteredData.length && document.getElementById('infinite-loader')) {
                    document.getElementById('infinite-loader').style.display = 'none'; 
                }
                isLoadingMore = false;
            }, 500);
        }
    });
}, { root: document.getElementById('mainContentArea'), rootMargin: '0px 0px 200px 0px', threshold: 0.1 });

if (document.getElementById('scroll-sentinel')) infiniteScrollObserver.observe(document.getElementById('scroll-sentinel'));

function renderBooksUI(startIndex, count, customData = null) {
    const container = document.getElementById("bookContainer");
    let dataToRender = customData ? customData : mainFilteredData;
    let endIndex = Math.min(startIndex + count, dataToRender.length);
    if(startIndex === 0) container.innerHTML = "";
    let htmlChunk = "";
    for(let i = startIndex; i < endIndex; i++) {
        let book = dataToRender[i];
        let langClass = book.lang.toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        let isSaved = savedBooks.includes(book.slug);
        let bookmarkIcon = isSaved ? 'fas fa-bookmark' : 'far fa-bookmark';
        
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `<div class="book-card" data-slug="${book.slug}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="${bookmarkIcon}"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
    }
    container.insertAdjacentHTML('beforeend', htmlChunk); 
    loadedCount = endIndex;
}

document.getElementById('bookContainer').addEventListener('click', (e) => {
    const card = e.target.closest('.book-card');
    if(card) {
        const slug = card.getAttribute('data-slug');
        const bookmarkBtn = e.target.closest('.bookmark-btn');
        if(bookmarkBtn) toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug); 
        else openDownloadPageLocal(slug);
    }
});

// SILENT BOOKMARK TOGGLE (No Toast Message)
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
    if(document.getElementById('bookmarks-panel').classList.contains('active')) renderSavedBooksUI(); 
}

function renderSavedBooksUI() {
    syncAndSanitizeBookmarks();
    const container = document.getElementById("savedBooksContainer"); 
    const noMsg = document.getElementById("no-saved-msg");
    const savedBooksData = booksData.filter(book => savedBooks.includes(book.slug));
    
    if (savedBooksData.length === 0) { 
        container.innerHTML = ""; 
        noMsg.style.display = "flex"; 
        return; 
    }
    noMsg.style.display = "none"; 
    let htmlChunk = "";
    savedBooksData.forEach(book => {
        let langClass = book.lang.toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `<div class="book-card" data-slug="${book.slug}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="fas fa-bookmark"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
    });
    container.innerHTML = htmlChunk;
}

document.getElementById('savedBooksContainer').addEventListener('click', (e) => {
    const card = e.target.closest('.book-card');
    if(card) {
        const slug = card.getAttribute('data-slug');
        const bookmarkBtn = e.target.closest('.bookmark-btn');
        if(bookmarkBtn) toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug); 
        else openDownloadPageLocal(slug); 
    }
});

// ==========================================
// NAVIGATION & MODALS
// ==========================================
document.getElementById('open-search').addEventListener('click', () => { 
    history.pushState({ popup: 'search' }, ''); 
    document.getElementById('search-box').classList.add('active'); 
    setTimeout(() => { searchInputEl.focus(); }, 300); 
});

document.getElementById('open-noti').addEventListener('click', () => { 
    history.pushState({ popup: 'noti' }, ''); 
    document.getElementById('noti-panel').classList.add('active'); 
    
    const blinkDot = document.querySelector('.blink-dot');
    if (blinkDot) blinkDot.style.display = 'none'; 
    
    if (livePosts.length > 0) {
        renderChannelFeed(livePosts, true);
    } else {
        renderChannelLoader();
    }
});

if (closeNotiBtn) {
    closeNotiBtn.addEventListener('click', () => {
        if (history.state && history.state.popup === 'noti') {
            history.back();
        } else {
            document.getElementById('noti-panel').classList.remove('active');
        }
    });
}

const sidebar = document.getElementById('sidebar'); 
const sidebarOverlay = document.getElementById('sidebar-overlay');
document.getElementById('open-menu').addEventListener('click', () => { 
    history.pushState({ popup: 'sidebar' }, ''); 
    sidebar.classList.add('active'); 
    sidebarOverlay.classList.add('active'); 
});
sidebarOverlay.addEventListener('click', () => { history.back(); });

document.getElementById('menu-dmca').addEventListener('click', (e) => { 
    e.preventDefault(); 
    history.pushState({ popup: 'dmca' }, ''); 
    document.getElementById('dmca-panel').classList.add('active'); 
    sidebar.classList.remove('active'); 
    sidebarOverlay.classList.remove('active'); 
});
document.getElementById('close-dmca-btn').addEventListener('click', () => { history.back(); });

document.getElementById('menu-bookmarks').addEventListener('click', (e) => { 
    e.preventDefault(); 
    history.pushState({ popup: 'bookmarks' }, ''); 
    document.getElementById('bookmarks-panel').classList.add('active'); 
    sidebar.classList.remove('active'); 
    sidebarOverlay.classList.remove('active'); 
    renderSavedBooksUI(); 
});
document.getElementById('close-bookmarks-btn').addEventListener('click', () => { history.back(); });

function switchTab(tabId) { 
    document.querySelectorAll('.app-tab').forEach(tab => { 
        tab.style.display = 'none'; 
        tab.classList.remove('active'); 
    }); 
    const target = document.getElementById(tabId); 
    if(target) { 
        target.style.display = 'flex'; 
        setTimeout(() => target.classList.add('active'), 10); 
    } 
}

function setNavActive(id) { 
    document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active')); 
    document.getElementById(id).classList.add('active'); 
}

function closeAllPanels() { 
    document.getElementById('noti-panel').classList.remove('active'); 
    document.getElementById('sidebar').classList.remove('active'); 
    document.getElementById('sidebar-overlay').classList.remove('active'); 
    document.getElementById('dmca-panel').classList.remove('active'); 
    document.getElementById('bookmarks-panel').classList.remove('active'); 
    document.getElementById('search-box').classList.remove('active'); 
}

window.updateHeaderForTab = function(tab) {
    const headerEl = document.getElementById('main-header');
    const titleEl = document.getElementById('dynamic-header-title');
    const iconsEl = document.getElementById('dynamic-header-icons');
    
    if(tab === 'home') {
        headerEl.style.display = 'flex';
        titleEl.innerText = 'SPIDY BOOK HUB';
        iconsEl.style.display = 'flex';
    } else if(tab === 'upload') {
        headerEl.style.display = 'flex';
        titleEl.innerText = 'UPLOAD BOOKS';
        iconsEl.style.display = 'none';
    } else if(tab === 'about') {
        headerEl.style.display = 'none';
    }
};

document.getElementById('nav-home').addEventListener('click', () => { 
    setNavActive('nav-home'); 
    closeAllPanels(); 
    switchTab('tab-home'); 
    window.updateHeaderForTab('home');
    window.history.replaceState({}, '', window.location.pathname); 
});

document.getElementById('nav-upload').addEventListener('click', () => {
    if(!isUserLoggedIn) { 
        document.getElementById('loginOverlay').style.display = 'flex'; 
        setTimeout(() => document.getElementById('loginOverlay').style.opacity = '1', 10); 
        setNavActive('nav-home'); 
        return; 
    }
    setNavActive('nav-upload'); 
    closeAllPanels(); 
    switchTab('tab-upload'); 
    window.updateHeaderForTab('upload');
    
    setTimeout(() => { 
        checkAndShowUploadTutorialPopup(); 
    }, 300);
});

document.getElementById('nav-dev').addEventListener('click', () => { 
    if(!isUserLoggedIn) {
        document.getElementById('loginOverlay').style.display = 'flex';
        setTimeout(() => document.getElementById('loginOverlay').style.opacity = '1', 10);
        return;
    }
    setNavActive('nav-dev'); 
    closeAllPanels(); 
    switchTab('tab-about'); 
    window.updateHeaderForTab('about');
    initParticles('particlesTabMe');
    syncProfileAndRankUI();
});

window.addEventListener('popstate', () => {
    closeAllPanels(); 
    applyMasterFilter();
    const sBook = new URLSearchParams(window.location.search).get('book');
    if(sBook) { openDownloadPageLocal(sBook, true); } 
    else { 
        document.getElementById("downloadModal").style.display = "none";
        document.getElementById("pdfViewerOverlay").style.display = "none";
        document.getElementById('pdfScrollContainer').innerHTML = '';
        cleanupPdfResources();
    }
});

function cleanupPdfResources() {
    currentPdfDocument = null;
    pdfTextCache = [];
    searchMatches = [];
    currentSearchMatchIndex = -1;
    document.getElementById('pdfSearchBar').style.display = 'none';
    document.getElementById('pdfSearchInput').value = '';
    document.getElementById('pdfSearchCount').innerText = '0/0';
    const badge = document.getElementById('pdfPageBadge');
    if (badge) badge.style.display = 'none';
}

// =========================================================================
// ADOBE-STYLE FLOATING PAGE BADGE ON REAL-TIME RENDERED PROGRESS
// =========================================================================
async function renderPdfInModal(pdfUrl) {
    const scrollContainer = document.getElementById('pdfScrollContainer');
    scrollContainer.innerHTML = `
        <div id="pdfLoadingStatus" style="color: #38bdf8; margin-top: 50px; font-size: 15px; font-weight: 600; text-align: center;">
            <i class="fas fa-spinner fa-spin" style="font-size: 26px; margin-bottom: 12px; display: block;"></i>
            Loading book...
        </div>`;

    cleanupPdfResources();

    try {
        const loadingTask = window.pdfjsLib.getDocument({
            url: pdfUrl,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true
        });

        const pdf = await loadingTask.promise;
        currentPdfDocument = pdf;
        pdfTotalPagesCount = pdf.numPages;
        scrollContainer.innerHTML = '';

        document.getElementById('pdfCurrentPageNum').innerText = `1`;
        document.getElementById('goToPageRange').innerText = `1 - ${pdfTotalPagesCount}`;

        const screenWidth = window.innerWidth;
        const targetCssWidth = Math.min(screenWidth - 20, 720);
        const pixelRatio = window.devicePixelRatio || 2; 

        const initialBatch = Math.min(pdf.numPages, 5);
        for (let pageNum = 1; pageNum <= initialBatch; pageNum++) {
            await renderSingleHdPage(pdf, pageNum, targetCssWidth, pixelRatio, scrollContainer);
        }

        const pageBadge = document.getElementById('pdfPageBadge');
        if (pageBadge) {
            pageBadge.style.display = 'flex';
            pageBadge.style.top = '14%'; 
        }

        (async () => {
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                if (document.getElementById('pdfViewerOverlay').style.display === 'none') break;

                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                const rawItems = textContent.items.map(item => item.str);
                
                const combinedRaw = rawItems.join(" ");
                const combinedClean = cleanUnicodeTextForSearch(combinedRaw);
                
                pdfTextCache[pageNum] = {
                    raw: combinedRaw,
                    clean: cleanUnicodeTextForSearch(combinedRaw)
                };

                if (pageNum > initialBatch) {
                    await renderSingleHdPage(pdf, pageNum, targetCssWidth, pixelRatio, scrollContainer);
                }
            }
        })();

        initPdfScrollTracker();

        // Pichle padhe gaye page par jump karne ka auto-logic
        const savedPage = localStorage.getItem(`last_read_${activeBookSlug}`);
        if (savedPage) {
            const targetPage = parseInt(savedPage, 10);
            if (targetPage > 1 && targetPage <= pdf.numPages) {
                setTimeout(() => {
                    jumpToPdfPage(targetPage);
                }, 350);
            }
        }

    } catch (err) {
        console.error("PDF Rendering Failed:", err);
        scrollContainer.innerHTML = `
            <div style="color: #ef4444; margin-top: 50px; text-align: center; padding: 25px;">
                <i class="fas fa-triangle-exclamation" style="font-size: 32px; margin-bottom: 12px; display: block;"></i>
                <strong>Failed to load book pages</strong>
                <p style="font-size: 13px; color: #a1a1aa; margin: 10px 0 0 0;">The network interrupted the download process or book is unavailable.</p>
            </div>`;
    }
}

async function renderSingleHdPage(pdf, pageNum, targetCssWidth, pixelRatio, container) {
    if (document.getElementById(`page_wrapper_${pageNum}`)) return;

    const page = await pdf.getPage(pageNum);
    const unscaledViewport = page.getViewport({ scale: 1.0 });
    const scale = targetCssWidth / unscaledViewport.width;
    const viewport = page.getViewport({ scale: scale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.id = `page_wrapper_${pageNum}`;
    wrapper.dataset.pageNum = pageNum;
    wrapper.style.width = `${targetCssWidth}px`;
    wrapper.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${targetCssWidth}px`;
    canvas.style.height = `${viewport.height}px`;

    const renderContext = {
        canvasContext: context,
        viewport: viewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0]
    };

    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    await page.render(renderContext).promise;
}

// ADOBE-STYLE PROGRESS TRACKER & LAST READ PAGE TRACKER
function initPdfScrollTracker() {
    const container = document.getElementById('pdfContainer');
    const badge = document.getElementById('pdfCurrentPageNum');
    const badgeWrap = document.getElementById('pdfPageBadge');

    container.addEventListener('scroll', () => {
        const wrappers = container.querySelectorAll('.pdf-page-wrapper');
        const containerCenter = container.getBoundingClientRect().top + (container.clientHeight / 3);
        let currentPageNum = 1;

        for (let wrap of wrappers) {
            const rect = wrap.getBoundingClientRect();
            if (rect.top <= containerCenter && rect.bottom >= containerCenter) {
                currentPageNum = parseInt(wrap.dataset.pageNum, 10);
                if (badge.innerText !== wrap.dataset.pageNum) {
                    badge.innerText = wrap.dataset.pageNum;
                }
                break;
            }
        }

        // Har scroll par current book ka exact page save hoga
        if (activeBookSlug && currentPageNum > 0) {
            localStorage.setItem(`last_read_${activeBookSlug}`, currentPageNum);
        }

        if (pdfTotalPagesCount > 1 && badgeWrap) {
            const isSearchBarOpen = document.getElementById('pdfSearchBar')?.style.display === 'flex';
            const baseTop = isSearchBarOpen ? 20 : 14; 
            const pageRatio = (currentPageNum - 1) / (pdfTotalPagesCount - 1);
            const calculatedTop = baseTop + (pageRatio * 68); 
            badgeWrap.style.top = `${calculatedTop}%`;
        }
    }, { passive: true });
}

// "GO TO PAGE" MODAL LOGIC
const pdfPageBadge = document.getElementById('pdfPageBadge');
const goToPageModal = document.getElementById('goToPageModal');
const cancelGoToPageBtn = document.getElementById('cancelGoToPageBtn');
const confirmGoToPageBtn = document.getElementById('confirmGoToPageBtn');
const goToPageInput = document.getElementById('goToPageInput');

pdfPageBadge.addEventListener('click', () => {
    goToPageInput.value = '';
    goToPageModal.style.display = 'flex';
    goToPageInput.focus();
});

cancelGoToPageBtn.addEventListener('click', () => {
    goToPageModal.style.display = 'none';
});

goToPageModal.addEventListener('click', (e) => {
    if (e.target === goToPageModal) goToPageModal.style.display = 'none';
});

confirmGoToPageBtn.addEventListener('click', () => {
    executeGoToPage();
});

goToPageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeGoToPage();
});

function executeGoToPage() {
    const val = parseInt(goToPageInput.value.trim(), 10);
    if (!isNaN(val) && val >= 1 && val <= pdfTotalPagesCount) {
        goToPageModal.style.display = 'none';
        jumpToPdfPage(val);
    } else {
        showToast(`Please enter a page between 1 and ${pdfTotalPagesCount}`, "error");
    }
}

async function jumpToPdfPage(pageNum) {
    let targetWrapper = document.getElementById(`page_wrapper_${pageNum}`);
    
    if (!targetWrapper && currentPdfDocument) {
        const screenWidth = window.innerWidth;
        const targetCssWidth = Math.min(screenWidth - 20, 720);
        const pixelRatio = window.devicePixelRatio || 2;
        const scrollContainer = document.getElementById('pdfScrollContainer');

        for (let i = 1; i <= pageNum; i++) {
            if (!document.getElementById(`page_wrapper_${i}`)) {
                await renderSingleHdPage(currentPdfDocument, i, targetCssWidth, pixelRatio, scrollContainer);
            }
        }
        targetWrapper = document.getElementById(`page_wrapper_${pageNum}`);
    }

    if (targetWrapper) {
        targetWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.getElementById('pdfCurrentPageNum').innerText = pageNum.toString();
        
        if (pdfTotalPagesCount > 1 && pdfPageBadge) {
            const isSearchBarOpen = document.getElementById('pdfSearchBar')?.style.display === 'flex';
            const baseTop = isSearchBarOpen ? 20 : 14;
            const pageRatio = (pageNum - 1) / (pdfTotalPagesCount - 1);
            pdfPageBadge.style.top = `${baseTop + (pageRatio * 68)}%`;
        }
    }
}

// IN-DOCUMENT SEARCH CONTROLLER
const pdfSearchToggleBtn = document.getElementById('pdfSearchToggleBtn');
const pdfSearchBar = document.getElementById('pdfSearchBar');
const pdfSearchCloseBtn = document.getElementById('pdfSearchCloseBtn');
const pdfSearchInput = document.getElementById('pdfSearchInput');
const pdfSearchCount = document.getElementById('pdfSearchCount');
const pdfSearchNextBtn = document.getElementById('pdfSearchNextBtn');
const pdfSearchPrevBtn = document.getElementById('pdfSearchPrevBtn');

pdfSearchToggleBtn.addEventListener('click', () => {
    if (pdfSearchBar.style.display === 'flex') {
        pdfSearchBar.style.display = 'none';
        if (pdfPageBadge) pdfPageBadge.style.top = '14%';
    } else {
        pdfSearchBar.style.display = 'flex';
        if (pdfPageBadge) pdfPageBadge.style.top = '20%';
        pdfSearchInput.focus();
    }
});

pdfSearchCloseBtn.addEventListener('click', () => {
    pdfSearchBar.style.display = 'none';
    pdfSearchInput.value = '';
    searchMatches = [];
    currentSearchMatchIndex = -1;
    pdfSearchCount.innerText = '0/0';
    if (pdfPageBadge) pdfPageBadge.style.top = '14%';
});

let pdfSearchTimer;
pdfSearchInput.addEventListener('input', () => {
    clearTimeout(pdfSearchTimer);
    pdfSearchTimer = setTimeout(() => {
        executePdfTextSearch(pdfSearchInput.value.trim());
    }, 250);
});

async function executePdfTextSearch(query) {
    searchMatches = [];
    currentSearchMatchIndex = -1;

    if (!query || query.length < 1 || !currentPdfDocument) {
        pdfSearchCount.innerText = '0/0';
        return;
    }

    const cleanQuery = cleanUnicodeTextForSearch(query);
    const lowerRawQuery = query.toLowerCase();

    for (let pageNum = 1; pageNum <= pdfTotalPagesCount; pageNum++) {
        let cached = pdfTextCache[pageNum];
        if (!cached) {
            try {
                const page = await currentPdfDocument.getPage(pageNum);
                const content = await page.getTextContent();
                const rawCombined = content.items.map(item => item.str).join(" ");
                cached = {
                    raw: rawCombined,
                    clean: cleanUnicodeTextForSearch(rawCombined)
                };
                pdfTextCache[pageNum] = cached;
            } catch (e) {
                continue;
            }
        }

        const matchFound = cached.raw.toLowerCase().includes(lowerRawQuery) || 
                           (cleanQuery.length > 0 && cached.clean.includes(cleanQuery));

        if (matchFound) {
            searchMatches.push(pageNum);
        }
    }

    if (searchMatches.length > 0) {
        currentSearchMatchIndex = 0;
        pdfSearchCount.innerText = `1/${searchMatches.length}`;
        jumpToPdfPage(searchMatches[0]);
    } else {
        pdfSearchCount.innerText = '0/0';
    }
}

pdfSearchNextBtn.addEventListener('click', () => {
    if (searchMatches.length === 0) return;
    currentSearchMatchIndex = (currentSearchMatchIndex + 1) % searchMatches.length;
    pdfSearchCount.innerText = `${currentSearchMatchIndex + 1}/${searchMatches.length}`;
    jumpToPdfPage(searchMatches[currentSearchMatchIndex]);
});

pdfSearchPrevBtn.addEventListener('click', () => {
    if (searchMatches.length === 0) return;
    currentSearchMatchIndex = (currentSearchMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    pdfSearchCount.innerText = `${currentSearchMatchIndex + 1}/${searchMatches.length}`;
    jumpToPdfPage(searchMatches[currentSearchMatchIndex]);
});

// ==========================================
// SECURE READ ONLINE (RING DOT LOADER & Ready..)
// ==========================================
const detectTokenFromUrl = new URLSearchParams(window.location.search).get('t');
if (detectTokenFromUrl) {
    document.getElementById('tokenInput').value = detectTokenFromUrl;
    window.history.replaceState({}, document.title, window.location.pathname);
    document.getElementById('tokenModalOverlay').style.display = 'flex';
    initParticles('particles');
}

function openDownloadPageLocal(slug, skipPushState = false) {
    if(!isUserLoggedIn) {
        document.getElementById('loginOverlay').style.display = 'flex'; 
        setTimeout(() => document.getElementById('loginOverlay').style.opacity = '1', 10); 
        return;
    }
    const book = booksData.find(b => b.slug === slug); 
    if(!book) return;
    
    document.getElementById("downloadModal").style.display = "flex";
    
    const previewImg = document.getElementById("dlPreviewImage");
    previewImg.classList.add("image-loading-skeleton"); 
    previewImg.src = getSecureAssetUrl(book.image); 
    previewImg.onerror = () => { previewImg.src = DEFAULT_AVATAR; };
    previewImg.onload = () => { previewImg.classList.remove("image-loading-skeleton"); };

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
        totalPagesSub.innerText = book.totalPages ? `${book.totalPages} Pages Included` : "Complete Book Included";
    }
    
    // Silent PDF Download click (No Toast Message)
    const dlPdfBtn = document.getElementById("dlPdfLinkBtn");
    dlPdfBtn.style.pointerEvents = "auto"; 
    dlPdfBtn.onclick = function(e) { 
        e.preventDefault(); 
    };

    document.getElementById("dlReadOnlineBtn").onclick = async function() {
        if(!isUserLoggedIn || !auth.currentUser) { 
            document.getElementById('loginOverlay').style.display = 'flex'; 
            setTimeout(() => document.getElementById('loginOverlay').style.opacity = '1', 10); 
            return; 
        }
        
        const btn = document.getElementById("dlReadOnlineBtn"); 
        const originalText = btn.innerHTML; 

        const savedData = localStorage.getItem('spidy_secure_session');
        let hasValidToken = false;

        if (savedData) {
            try {
                const parsed = JSON.parse(savedData);
                if (parsed.fp === generateDeviceFingerprint() && parsed.expiry > Date.now()) {
                    hasValidToken = true;
                }
            } catch(e) {}
        }

        if(!hasValidToken && !IS_SUPER_ADMIN) {
             document.getElementById('tokenModalOverlay').style.display = 'flex';
             initParticles('particles');
             return; 
        }
        
        // Attractive Dot-Ring SVG Loader + "Ready.."
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" stroke="#ffffff" style="display:inline-block; vertical-align:middle; margin-right:6px;">
                <g fill="none" fill-rule="evenodd">
                    <g transform="translate(1 1)" stroke-width="3">
                        <circle stroke-opacity=".2" cx="18" cy="18" r="18"/>
                        <path d="M36 18c0-9.94-8.06-18-18-18">
                            <animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="0.8s" repeatCount="indefinite"/>
                        </path>
                    </g>
                </g>
            </svg>
            Ready..
        `; 
        btn.disabled = true;

        try {
            const userToken = await auth.currentUser.getIdToken(false);

            const response = await fetch('/api/get-book', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    bookId: book.id, 
                    bookSlug: book.slug, 
                    userToken: userToken 
                })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                if (typeof data.remainingCredits !== 'undefined') {
                    updateLiveCredits(data.remainingCredits);
                }

                syncProfileAndRankUI();

                const pdfViewer = document.getElementById('pdfViewerOverlay');
                const title = document.getElementById('pdfViewerTitle');
                
                title.innerText = sanitizeHTML(book.title);
                
                pdfViewer.style.display = 'flex';
                renderPdfInModal(data.pdfLink);

            } else {
                if (response.status === 401 || (data.error && data.error.includes('Unauthorized'))) {
                    localStorage.removeItem('spidy_secure_session');
                    document.getElementById('tokenModalOverlay').style.display = 'flex';
                    initParticles('particles');
                } else {
                    showToast(data.error || "Aapka 24 ghante ka limit paar ho gaya hai!", "error");
                }
            }

            btn.innerHTML = originalText; 
            btn.disabled = false;

        } catch (error) { 
            showToast("Network Error: Could not load the book.", "error"); 
            btn.innerHTML = originalText; 
            btn.disabled = false; 
        }
    };

    document.getElementById("closePdfViewerBtn").onclick = function() {
        document.getElementById('pdfViewerOverlay').style.display = 'none';
        document.getElementById('pdfScrollContainer').innerHTML = ''; 
        cleanupPdfResources();
    };

    document.getElementById("pdfContainer").addEventListener('contextmenu', event => event.preventDefault());

    let examsArray = (book.exams || "General").split(',').map(item => sanitizeHTML(item.trim()));
    document.getElementById("dlModalTags").innerHTML = examsArray.map(exam => `<div class="dl-modal-tag">${exam}</div>`).join('');
    activeBookSlug = book.slug; 
    activeBookTitle = book.title;
    
    if (!skipPushState) { 
        history.pushState({ popup: 'book' }, '', '?book=' + book.slug); 
    }
}

document.getElementById('closeDlBtn').addEventListener('click', closeDownloadPageLocal);
function closeDownloadPageLocal() {
    if (history.state && history.state.popup === 'book') { 
        history.back(); 
    } else { 
        document.getElementById("downloadModal").style.display = "none"; 
        window.history.replaceState({}, '', window.location.pathname); 
    }
    if(isDeepLinkLoad) {
        isDeepLinkLoad = false; 
        const loader = document.getElementById("loaderScreen"); 
        loader.style.display = "flex"; 
        loader.style.opacity = "1"; 
        updateLoaderUI(100);
        setTimeout(() => { 
            loader.style.opacity = "0"; 
            setTimeout(() => { 
                loader.style.display = "none"; 
                initPremiumPopups(); 
            }, 300); 
        }, 1500); 
    }
}

document.getElementById('shareBookBtn').addEventListener('click', () => {
    const shareUrl = window.location.origin + window.location.pathname + "?book=" + activeBookSlug;
    if (navigator.share) {
        navigator.share({ title: activeBookTitle, text: "Read this book online", url: shareUrl });
    } else { 
        navigator.clipboard.writeText(shareUrl); 
        showToast("Link Copied!", "success"); 
    }
});

// ==========================================
// REPORT ISSUE MODAL
// ==========================================
document.getElementById('reportLinkBtn').addEventListener('click', () => {
    document.getElementById('reportModalOverlay').classList.add('active');
});

document.getElementById('closeReportBtn').addEventListener('click', () => {
    document.getElementById('reportModalOverlay').classList.remove('active');
});

document.getElementById('reportModalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('reportModalOverlay')) {
        document.getElementById('reportModalOverlay').classList.remove('active');
    }
});

const reportOptions = document.querySelectorAll('.rm-option');
const submitReportBtn = document.getElementById('submitReportBtn');

reportOptions.forEach(opt => {
    opt.addEventListener('click', () => {
        reportOptions.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        submitReportBtn.classList.add('enabled');
    });
});

submitReportBtn.addEventListener('click', async () => {
    const selectedOption = document.querySelector('.rm-option.selected');
    if (selectedOption) {
        const issueType = selectedOption.querySelector('span').innerText;
        
        try {
            await addDoc(collection(db, "reports"), {
                bookTitle: activeBookTitle || "Unknown",
                bookSlug: activeBookSlug || "Unknown",
                issueType: issueType,
                status: 'Pending',
                reportedBy: (auth.currentUser && auth.currentUser.email) ? auth.currentUser.email : 'Unknown User',
                createdAt: new Date().getTime()
            });
        } catch (error) {
            console.error("Failed to send report:", error);
        }

        submitReportBtn.innerHTML = '<i class="fas fa-check-circle"></i> Successfully Reported';
        submitReportBtn.style.background = '#10b981';
        submitReportBtn.style.boxShadow = "inset 0 0 20px rgba(16, 185, 129, 0.4), 0 4px 15px rgba(16, 185, 129, 0.3)";
        
        setTimeout(() => {
            document.getElementById('reportModalOverlay').classList.remove('active');
            setTimeout(() => {
                submitReportBtn.innerHTML = 'Submit Report';
                submitReportBtn.style.background = '#ef4444';
                submitReportBtn.style.boxShadow = '0 4px 15px rgba(239, 68, 68, 0.3)';
                submitReportBtn.classList.remove('enabled');
                reportOptions.forEach(o => o.classList.remove('selected'));
            }, 400);
        }, 1200);
    }
});

// ==========================================
// TOKEN VERIFICATION MODAL
// ==========================================
document.getElementById('closeTokenModalBtn').addEventListener('click', () => {
    document.getElementById('tokenModalOverlay').style.display = 'none';
});

document.getElementById('tokenInput').addEventListener('input', () => {
    document.getElementById('inputBoxWrapperToken').classList.remove('error-state', 'success-state');
});

document.getElementById('getKeyBtn').addEventListener('click', () => {
    const btn = document.getElementById('getKeyBtn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    
    setTimeout(() => {
        window.location.href = "https://arolinks.com/6RTf5";
        btn.innerHTML = originalContent;
    }, 600);
});

document.getElementById('verifyBtn').addEventListener('click', async () => {
    const tokenInput = document.getElementById('tokenInput');
    const tokenValue = tokenInput.value.trim();
    const inputBox = document.getElementById('inputBoxWrapperToken');
    const btn = document.getElementById('verifyBtn');

    inputBox.classList.remove('error-state', 'success-state');

    if (tokenValue.length < 5) {
        inputBox.classList.add('error-state');
        setTimeout(() => inputBox.classList.remove('error-state'), 2500); 
        showToast('Invalid Token Format!', 'error');
        return;
    }

    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';

    const currentFingerprint = generateDeviceFingerprint();

    try {
        const response = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenValue, fingerprint: currentFingerprint })
        });

        const data = await response.json();

        if (response.ok) {
            inputBox.classList.add('success-state');
            showToast('Access Granted! Valid for 24 Hours.', 'success');
            
            localStorage.setItem('spidy_secure_session', JSON.stringify({
                token: tokenValue,
                fp: currentFingerprint,
                expiry: Date.now() + 24 * 60 * 60 * 1000 
            }));

            setTimeout(() => {
                document.getElementById('tokenModalOverlay').style.display = 'none';
                btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
                document.getElementById("dlReadOnlineBtn").click();
            }, 1000);

        } else {
            inputBox.classList.add('error-state');
            showToast(data.error || 'Verification Failed', 'error');
            btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
        }
    } catch (err) {
        inputBox.classList.add('error-state');
        showToast('Server Error! Cannot verify token right now.', 'error');
        btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
    }
});

// ==========================================
// UPLOADS & FILE SELECTION TRACKING
// ==========================================
['fileCoverGallery', 'fileCoverBrowse'].forEach(id => {
    document.getElementById(id).addEventListener('change', function(e) {
        if(e.target.files.length > 0) {
            selectedCoverFile = e.target.files[0]; 
            e.target.closest('.uc-actions').querySelector('p').innerText = "Selected: " + selectedCoverFile.name;
        }
    });
});

['filePdfGallery', 'filePdfBrowse'].forEach(id => {
    document.getElementById(id).addEventListener('change', async function(e) {
        if(e.target.files.length > 0) {
            selectedPdfFile = e.target.files[0]; 
            const statusP = e.target.closest('.uc-actions').querySelector('p');
            statusP.innerText = `Analyzing: ${selectedPdfFile.name}...`;

            const sizeInMB = (selectedPdfFile.size / (1024 * 1024)).toFixed(2);
            detectedFileSizeMB = `${sizeInMB} MB`;

            try {
                if (window.pdfjsLib) {
                    const arrayBuffer = await selectedPdfFile.arrayBuffer();
                    const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
                    const pdfDoc = await loadingTask.promise;
                    detectedTotalPages = pdfDoc.numPages;
                    statusP.innerText = `Selected: ${selectedPdfFile.name} (${detectedFileSizeMB} • ${detectedTotalPages} Pages)`;
                } else {
                    statusP.innerText = `Selected: ${selectedPdfFile.name} (${detectedFileSizeMB})`;
                }
            } catch (err) {
                console.warn("Could not calculate pages:", err);
                statusP.innerText = `Selected: ${selectedPdfFile.name} (${detectedFileSizeMB})`;
            }
        }
    });
});

// =========================================================================
// REAL-TIME UPLOAD PIPELINE CONTROLLER
// =========================================================================
function uploadSingleFileTracked(file, type, onProgress) {
    return new Promise(async (resolve, reject) => {
        const folderPrefix = type === 'image' ? 'covers' : 'pdfs';
        const fileExt = file.name.split('.').pop().toLowerCase() || (type === 'image' ? 'jpg' : 'pdf');
        const rawSafeName = file.name
            .replace(/\.[^/.]+$/, "")
            .replace(/[^a-zA-Z0-9_-]/g, "")
            .slice(0, 25);
            
        const safeFilePayload = `${folderPrefix}/${Date.now()}_${rawSafeName || 'file'}.${fileExt}`;
        const determinedContentType = (type === 'image') ? (file.type || 'image/jpeg') : 'application/pdf';

        try {
            const userToken = await auth.currentUser.getIdToken(true);
            const authResponse = await fetch('/api/generate-upload-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    fileName: safeFilePayload, 
                    fileType: determinedContentType, 
                    userToken: userToken 
                })
            });
            
            const authData = await authResponse.json();
            if (!authResponse.ok) {
                throw new Error(authData.error || "Permission Denied by Backend Server");
            }

            const xhr = new XMLHttpRequest(); 
            xhr.open("PUT", authData.uploadUrl, true); 
            xhr.setRequestHeader("Content-Type", determinedContentType); 

            xhr.upload.addEventListener("progress", (e) => {
                if (e.lengthComputable && onProgress) { 
                    onProgress(e.loaded, e.total);
                }
            });

            xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(authData.fileKey || safeFilePayload);
                } else { 
                    reject(new Error(`Storage rejected upload with status: ${xhr.status}`)); 
                }
            };

            xhr.onerror = function() { 
                reject(new Error("R2 upload blocked. Please verify CORS in Cloudflare dashboard.")); 
            }; 

            xhr.send(file);

        } catch (error) {
            reject(error);
        }
    });
}

// PUBLISH BOOK CONTROLLER (Spinner first, Static Checkmark on 100%)
document.getElementById('addBookForm').addEventListener('submit', async (e) => {
    e.preventDefault(); 
    
    if (!selectedCoverFile) { showToast("Please select a Cover Image!", "error"); return; }
    if (!selectedPdfFile) { showToast("Please select a PDF file!", "error"); return; }

    const pipelineOverlay = document.getElementById('uploadPipelineOverlay');
    const dynamicTitle = document.getElementById('syncDynamicTitle');
    const dynamicPdfSize = document.getElementById('syncDynamicPdfSize');
    const percentDisplay = document.getElementById('syncPercentDisplay');
    const transferredBytes = document.getElementById('syncTransferredBytes');
    const speedVal = document.getElementById('syncSpeedVal');
    const progressFill = document.getElementById('syncProgressFill');
    const stageTitle = document.getElementById('syncStageTitle');
    const stageSub = document.getElementById('syncStageSub');
    const liveCoverImg = document.getElementById('syncLiveCoverImg');
    const defaultCoverIcon = document.getElementById('syncDefaultCoverIcon');
    const spinner = document.getElementById('syncStageSpinner');

    if (spinner) {
        spinner.className = "stage-spinner";
        spinner.innerHTML = "";
        spinner.style.border = "2px solid rgba(255, 255, 255, 0.15)";
        spinner.style.borderTopColor = "#ffffff";
        spinner.style.background = "transparent";
        spinner.style.width = "17px";
        spinner.style.height = "17px";
    }

    const inputTitle = document.getElementById('inTitle').value.trim() || selectedPdfFile.name;
    dynamicTitle.innerText = inputTitle;
    dynamicPdfSize.innerText = `PDF Size: ${(selectedPdfFile.size / (1024 * 1024)).toFixed(2)} MB`;

    const coverReader = new FileReader();
    coverReader.onload = function(evt) {
        liveCoverImg.src = evt.target.result;
        liveCoverImg.style.display = 'block';
        defaultCoverIcon.style.display = 'none';
    };
    coverReader.readAsDataURL(selectedCoverFile);

    const totalBytesToUpload = selectedCoverFile.size + selectedPdfFile.size;
    const totalMB = (totalBytesToUpload / (1024 * 1024)).toFixed(2);
    
    let coverLoaded = 0;
    let pdfLoaded = 0;
    let lastLoaded = 0;
    let lastTime = Date.now();

    percentDisplay.innerHTML = `0<span class="percent-symbol">%</span>`;
    progressFill.style.width = `0%`;
    transferredBytes.innerText = `0.0 MB / ${totalMB} MB`;
    speedVal.innerText = `Connecting...`;
    stageTitle.innerText = "Connecting to Cloud Storage...";
    stageSub.innerText = "Allocating secure distribution channels";
    pipelineOverlay.style.display = 'flex';

    function updateTelemetry() {
        const totalUploadedNow = coverLoaded + pdfLoaded;
        const currentMB = (totalUploadedNow / (1024 * 1024)).toFixed(2);
        const percent = Math.min(98, Math.floor((totalUploadedNow / totalBytesToUpload) * 98));

        percentDisplay.innerHTML = `${percent}<span class="percent-symbol">%</span>`;
        progressFill.style.width = `${percent}%`;
        transferredBytes.innerText = `${currentMB} MB / ${totalMB} MB`;

        const now = Date.now();
        const timeDiff = (now - lastTime) / 1000;
        if (timeDiff >= 0.5) {
            const bytesDiff = totalUploadedNow - lastLoaded;
            const speedMBps = ((bytesDiff / (1024 * 1024)) / timeDiff).toFixed(1);
            speedVal.innerText = `${speedMBps} MB/s`;
            lastLoaded = totalUploadedNow;
            lastTime = now;
        }

        if (percent < 30) {
            stageTitle.innerText = "Transferring Cover Artwork...";
            stageSub.innerText = "Optimizing image resolution for mobile readers";
        } else if (percent < 85) {
            stageTitle.innerText = "Uploading Manuscript Pages...";
            stageSub.innerText = "Writing high-speed encrypted stream to Cloudflare R2";
        } else {
            stageTitle.innerText = "Finalizing Storage Nodes...";
            stageSub.innerText = "Preparing document metadata & secure tokens";
        }
    }

    try {
        stageTitle.innerText = "Transferring Cover Image...";
        const coverKey = await uploadSingleFileTracked(selectedCoverFile, 'image', (loaded) => {
            coverLoaded = loaded;
            updateTelemetry();
        });

        stageTitle.innerText = "Transferring PDF Manuscript...";
        const pdfKey = await uploadSingleFileTracked(selectedPdfFile, 'pdf', (loaded) => {
            pdfLoaded = loaded;
            updateTelemetry();
        });

        stageTitle.innerText = "Registering Book in Database...";
        stageSub.innerText = "Writing catalog details to Firebase Firestore";
        speedVal.innerText = "Syncing...";
        percentDisplay.innerHTML = `99<span class="percent-symbol">%</span>`;
        progressFill.style.width = `99%`;

        const newBook = { 
            title: inputTitle, 
            author: document.getElementById('inAuthor').value, 
            year: document.getElementById('inYear').value, 
            lang: document.getElementById('inLang').value, 
            exams: document.getElementById('inExams').value, 
            image: coverKey, 
            pdfLink: pdfKey, 
            fileSize: detectedFileSizeMB || "10 MB",
            fileFormat: "PDF",
            totalPages: detectedTotalPages ? detectedTotalPages.toString() : "100+",
            dateAdded: new Date().toLocaleDateString('en-GB').toUpperCase(), 
            createdAt: new Date().getTime(), 
            uploaderUid: auth.currentUser.uid 
        };

        await addDoc(collection(db, "books"), newBook);

        const userDocRef = doc(db, "users", auth.currentUser.uid);
        await setDoc(userDocRef, { 
            lastBookUploadTime: Date.now() 
        }, { merge: true });

        // 100% Complete: Static Green Checkmark Badge
        percentDisplay.innerHTML = `100<span class="percent-symbol">%</span>`;
        progressFill.style.width = `100%`;
        transferredBytes.innerText = `${totalMB} MB / ${totalMB} MB`;
        speedVal.innerText = "Completed";
        stageTitle.innerText = "Book Published Successfully! ✨";
        stageSub.innerText = "Live and ready for all readers";
        
        if (spinner) {
            spinner.className = "";
            spinner.style.border = "none";
            spinner.style.background = "#10b981";
            spinner.style.width = "22px";
            spinner.style.height = "22px";
            spinner.style.borderRadius = "50%";
            spinner.style.display = "flex";
            spinner.style.alignItems = "center";
            spinner.style.justifyContent = "center";
            spinner.style.boxShadow = "0 0 10px rgba(16, 185, 129, 0.6)";
            spinner.innerHTML = `<i class="fas fa-check" style="color:#000000; font-size:12px; font-weight:900;"></i>`;
        }

        setTimeout(() => {
            pipelineOverlay.style.display = 'none';
            e.target.reset(); 
            selectedCoverFile = null; 
            selectedPdfFile = null;
            detectedTotalPages = 0;
            detectedFileSizeMB = "0 MB";
            document.querySelectorAll('.uc-actions p').forEach(p => p.innerText = "Drag & Drop File");
            
            showToast("Book Published Successfully!", "success");
            document.getElementById('nav-home').click();
        }, 1200);

    } catch (error) {
        pipelineOverlay.style.display = 'none';
        showToast("Upload Error: " + error.message, "error"); 
    }
});

// ==========================================
// ADMIN SECTION TABS SWITCHER (WITH SCROLL RESET)
// ==========================================
document.querySelectorAll('.adm-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { 
        let tab = btn.id === 'admTabPrompt' ? 'prompt' : 'add'; 
        switchAdminTabLocal(tab); 
    });
});

function switchAdminTabLocal(tabName) {
    document.querySelectorAll('.adm-section').forEach(el => el.classList.remove('active')); 
    document.querySelectorAll('.adm-tab-btn').forEach(el => el.classList.remove('active'));
    
    const contentArea = document.getElementById('admContentArea');
    if (contentArea) {
        contentArea.scrollTop = 0;
    }

    if(tabName === 'add') { 
        document.getElementById('sectionAddBook').classList.add('active'); 
        document.getElementById('admTabAdd').classList.add('active'); 
    } else if(tabName === 'prompt') { 
        document.getElementById('sectionPrompt').classList.add('active'); 
        document.getElementById('admTabPrompt').classList.add('active'); 
    }
}
