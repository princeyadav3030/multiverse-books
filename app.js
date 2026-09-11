import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { 
    getFirestore, collection, addDoc, doc, updateDoc, onSnapshot, 
    query, orderBy, setDoc, getDoc, getDocs, Timestamp, limit 
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

// Cloudflare Worker Proxy Base URL
const WORKER_PROXY_URL = "https://spidy-proxy.spidybookhub-backend.workers.dev";
const DEFAULT_AVATAR = "https://i.postimg.cc/D0BF1b77/file-000000000e847207a64f6711d825a859.png";

// ==========================================
// 2. ASSET RESOLUTION HELPER
// ==========================================
function getSecureAssetUrl(fileKeyOrUrl) {
    if (!fileKeyOrUrl) return DEFAULT_AVATAR;
    if (fileKeyOrUrl.startsWith("http://") || fileKeyOrUrl.startsWith("https://")) {
        if (fileKeyOrUrl.includes("spidy-proxy.spidybookhub-backend.workers.dev")) {
            return fileKeyOrUrl;
        }
        if (fileKeyOrUrl.includes(".r2.cloudflarestorage.com")) {
            try {
                const parsed = new URL(fileKeyOrUrl);
                const pathKey = parsed.pathname.replace(/^\/+/, '');
                return `${WORKER_PROXY_URL}/${pathKey}`;
            } catch(e) {
                return fileKeyOrUrl;
            }
        }
        return fileKeyOrUrl;
    }
    const cleanKey = fileKeyOrUrl.replace(/^\/+/, '');
    return `${WORKER_PROXY_URL}/${cleanKey}`;
}

// ==========================================
// GLOBAL STATE
// ==========================================
let booksData = [];
let mainFilteredData = []; 
let loadedCount = 0; 
let isLoadingMore = false;
let activeBookSlug = ""; 
let activeBookId = "";
let activeBookTitle = "";

let IS_SUPER_ADMIN = false;
let isUserLoggedIn = false; 

let CURRENT_ADMIN_NAME = "Guest User";
let CURRENT_ADMIN_EMAIL = "";
let CURRENT_ADMIN_PHOTO = DEFAULT_AVATAR;

let savedBooks = JSON.parse(localStorage.getItem('spidy_saved_books')) || [];
let selectedCoverFile = null;
let selectedPdfFile = null;
let detectedTotalPages = 0;
let detectedFileSizeMB = "0 MB";

// Module Banners & Navigation State
let dynamicBannersList = [];
let activeBannerData = null;
let activeSubjectKey = null;

// Channel Notifications State
let livePosts = [];
let activePost = null;
let isInitialChannelLoad = true;
let unreadPostsCount = 0;
let isChannelDataReady = false;

// Virtual PDF State
let currentPdfDocument = null;
let pdfTotalPagesCount = 0;
let pdfTextCache = [];
let searchMatches = [];
let currentSearchMatchIndex = -1;
let renderedPagesMap = new Map();
let pdfVirtualObserver = null;
let activeSearchKeyword = "";

// ==========================================
// SANITIZE & UTILS
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
        .replace(/:::copy[\s\S]*?:::/g, '[Code Card]')
        .replace(/\n+/g, ' ')
        .trim();
}

function parseMarkdown(rawText) {
    if (!rawText) return "";
    let safe = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawText) : sanitizeHTML(rawText);

    safe = safe.replace(/:::copy\s*(?:\[(.*?)\])?([\s\S]*?):::/g, function(match, title, content) {
        let lines = (content || "").trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let listHtml = lines.map(line => `<li>${escapeHTML(line.replace(/^[•\-\*]\s*/, ''))}</li>`).join('');
        let copyText = lines.map(line => line.replace(/^[•\-\*]\s*/, '')).join('\n');
        let encodedCopy = encodeURIComponent(copyText);
        let cardTitle = (title || 'Free code').trim();

        return `<div class="tg-copy-card"><div class="tg-copy-header">${escapeHTML(cardTitle)}</div><div class="tg-copy-body"><ul>${listHtml}</ul></div><button type="button" class="tg-copy-action-btn" onclick="window.copyToClipboard(decodeURIComponent('${encodedCopy}'), this)"><i class="far fa-copy"></i> COPY CODE</button></div>`;
    });

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

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatReactionCount(num) {
    if (!num || num <= 0) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
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

let pillToastTimer;
function showToast(message, type = 'success') {
    let toast = document.getElementById('spidyPillToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'spidyPillToast';
        toast.className = 'spidy-pill-toast';
        document.body.appendChild(toast);
    }
    clearTimeout(pillToastTimer);
    toast.className = `spidy-pill-toast ${type}`;
    const icon = type === 'success' ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon}<span>${sanitizeHTML(message)}</span>`;
    toast.style.display = "flex";
    void toast.offsetWidth;
    toast.classList.add('active');

    pillToastTimer = setTimeout(() => { toast.classList.remove('active'); }, 2800);
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
    return str.normalize("NFD").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[^\p{L}\p{M}\p{N}]/gu, "").toLowerCase();
}

// =========================================================================
// 3. DYNAMIC MODULE BANNER CAROUSEL & NAVIGATION
// =========================================================================
let currentPromoIndex = 0;
let promoAutoSlideInterval = null;

function renderDynamicBanners(banners) {
    const track = document.getElementById('promoCarouselTrack');
    const dotsWrap = document.getElementById('promoDotsWrapper');
    if (!track || !dotsWrap) return;

    if (!banners || banners.length === 0) {
        track.innerHTML = `
            <div class="promo-slide">
                <img src="https://i.postimg.cc/Pq0JLj3C/file-0000000027dc82119d3731d4bfe9bccf.png" alt="Promo Banner" class="promo-banner-img">
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
    const prevBtn = document.getElementById('promoPrevBtn');
    const nextBtn = document.getElementById('promoNextBtn');
    const totalSlides = dots.length;

    if (!track || totalSlides === 0) return;
    if (promoAutoSlideInterval) clearInterval(promoAutoSlideInterval);

    function goToSlide(index) {
        currentPromoIndex = index;
        track.style.transform = `translateX(-${currentPromoIndex * 100}%)`;
        dots.forEach((dot, idx) => {
            if (idx === currentPromoIndex) dot.classList.add('active');
            else dot.classList.remove('active');
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
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            goToSlide(index);
            startAutoSlide();
        });
    });

    if (prevBtn) {
        prevBtn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            goToSlide(currentPromoIndex);
            startAutoSlide();
        };
    }

    if (nextBtn) {
        nextBtn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
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
        let diff = startX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 40) {
            if (diff > 0) currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
            else currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            goToSlide(currentPromoIndex);
        }
        startAutoSlide();
    };

    goToSlide(0);
    startAutoSlide();
}

// 🌟 OPEN BANNER & LOAD REAL SUBJECTS
window.openBannerModules = function(bannerId) {
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
                <div class="subject-icon-wrap ${sub.iconClass}">
                    ${sub.iconHtml}
                </div>
                <div class="subject-meta-text">
                    <div class="subject-name-main">${sub.name}</div>
                    <div class="subject-modules-count">${modulesArr.length} Modules Available</div>
                </div>
                <i class="fas fa-chevron-right pod-arrow-icon"></i>
            </div>`;
        }
    });

    if (html === "") {
        html = `<div style="text-align:center; padding:35px 20px; color:#a1a1aa; font-weight:700;">No modules uploaded for this banner yet.</div>`;
    }

    container.innerHTML = html;

    const modal = document.getElementById('moduleBannerModal');
    if (modal) modal.classList.add('active');
};

// 🌟 OPEN MODULES LIST FOR SELECTED SUBJECT WITH AUTO PAGE COUNT
window.openSubjectModulesList = function(subjectKey) {
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
        container.innerHTML = `<div style="text-align:center; padding:35px 20px; color:#a1a1aa;">No modules found in this subject.</div>`;
    } else {
        let html = "";
        modules.forEach(mod => {
            const rawPdfUrl = mod.pdfLink || "";
            const resolvedPdf = getSecureAssetUrl(rawPdfUrl);
            const encodedPdf = encodeURIComponent(resolvedPdf);
            const encodedTitle = encodeURIComponent(mod.name || "Module Document");
            
            // Auto Page display fallback (removes static '180 Pages')
            let pageLabel = "Complete Document";
            if (mod.pages && !mod.pages.includes("180 Pages")) {
                pageLabel = mod.pages.includes("Page") ? mod.pages : `${mod.pages} Pages`;
            }

            html += `
            <div class="module-pdf-card" onclick="window.readModulePdfDirectly(decodeURIComponent('${encodedPdf}'), decodeURIComponent('${encodedTitle}'))">
                <div class="module-pdf-badge">
                    <i class="fas fa-file-pdf"></i>
                </div>
                <div class="module-details-wrap">
                    <div class="module-title-h3">${escapeHTML(mod.name || 'Module')}</div>
                    <div class="module-chapters-sub">${escapeHTML(mod.sub || 'Chapters & topics included')}</div>
                    <span class="module-tag-pages" id="mod_badge_${mod.id}"><i class="fas fa-layer-group"></i> ${escapeHTML(pageLabel)}</span>
                </div>
                <i class="fas fa-chevron-right" style="color:rgba(255,255,255,0.25); font-size:0.9rem;"></i>
            </div>`;
        });
        container.innerHTML = html;
    }

    document.getElementById('bannerSubjectsView').classList.add('hidden-view');
    document.getElementById('bannerModulesView').classList.remove('hidden-view');
};

window.readModulePdfDirectly = function(pdfUrl, title) {
    if (!pdfUrl) return showToast("Module PDF document not linked yet.", "error");

    const pdfViewer = document.getElementById('pdfViewerOverlay');
    const titleEl = document.getElementById('pdfViewerTitle');

    if (titleEl) titleEl.innerText = title || "Reading Module...";
    if (pdfViewer) pdfViewer.style.display = 'flex';

    renderPdfInModal(pdfUrl);
};

document.getElementById('moduleBackBtn')?.addEventListener('click', () => {
    const modulesView = document.getElementById('bannerModulesView');
    if (modulesView && !modulesView.classList.contains('hidden-view')) {
        modulesView.classList.add('hidden-view');
        document.getElementById('bannerSubjectsView').classList.remove('hidden-view');
        document.getElementById('moduleHeaderTitle').innerText = (activeBannerData?.title || "MODULE PACK").toUpperCase();
    } else {
        document.getElementById('moduleBannerModal')?.classList.remove('active');
        activeBannerData = null;
        activeSubjectKey = null;
    }
});

// ==========================================
// 4. AUTHENTICATION & CORE SNAPSHOTS
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
                    createdAt: Date.now() 
                }, { merge: true });
                updateLiveCredits(20); 
            }

            syncProfileAndRankUI();

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

    onSnapshot(query(collection(db, "module_banners"), orderBy("createdAt", "desc")), (snapshot) => {
        dynamicBannersList = [];
        snapshot.forEach(docSnap => {
            let b = docSnap.data();
            b.id = docSnap.id;
            dynamicBannersList.push(b);
        });
        renderDynamicBanners(dynamicBannersList);
    });

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
            container.innerHTML += `<div class="telegram-prompt-wrapper">${instructionHTML}<div class="telegram-prompt-card"><div class="telegram-prompt-header">${safeTitle}</div><div class="telegram-prompt-body">${safeText}</div><div class="telegram-prompt-footer"><button class="telegram-copy-btn" data-text="${encodeURIComponent(data.text)}" id="copy-btn-${id}"><i class="far fa-copy"></i> COPY CODE</button></div></div></div>`;
        });
    });

    const q = query(collection(db, "books"), orderBy("createdAt", "desc"));
    onSnapshot(q, (snapshot) => {
        booksData = [];
        snapshot.forEach((docSnap) => {
            let data = docSnap.data(); 
            data.id = docSnap.id;
            const rawTitle = (data.title || "").trim().toLowerCase();
            const safeCandidate = encodeURIComponent(rawTitle.replace(/\s+/g, '-'));
            data.slug = (safeCandidate && safeCandidate !== "%20") ? safeCandidate : docSnap.id;
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
        livePosts = dataArr;
        renderChannelFeed(livePosts, true);
    });
});

document.getElementById('promptsContainer')?.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.telegram-copy-btn');
    if (copyBtn) {
        const textToCopy = decodeURIComponent(copyBtn.getAttribute('data-text'));
        window.copyToClipboard(textToCopy, copyBtn);
    }
});

// ==========================================
// LOGIN & LOGOUT
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
document.getElementById('closeLoginBtn')?.addEventListener('click', closeLoginOverlayLocal);
document.getElementById('toggleEye')?.addEventListener('click', () => {
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

document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
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

document.getElementById('googleSignInBtn')?.addEventListener('click', async () => { 
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
        } catch (error) { showToast("Error signing out!", "error"); }
    });
}

const uploadPopup = document.getElementById('uploadPopup');
const closeUploadPopupBtn = document.getElementById('closeUploadPopupBtn');
if (closeUploadPopupBtn && uploadPopup) {
    closeUploadPopupBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
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
searchInputEl?.addEventListener('input', () => { 
    clearTimeout(searchTimeout); 
    searchTimeout = setTimeout(() => { applyMasterFilter(); }, 250); 
});
document.getElementById('close-search')?.addEventListener('click', () => { 
    searchInputEl.value = ''; 
    applyMasterFilter(); 
    document.getElementById('search-box').classList.remove('active'); 
    if (history.state && history.state.popup === 'search') history.back();
});
document.getElementById('openAuthorFilterBtn')?.addEventListener('click', () => { 
    document.getElementById('filterBottomOverlay').classList.add('active'); 
});
document.getElementById('closeAuthorFilterBtn')?.addEventListener('click', () => { 
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
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        let isSaved = savedBooks.includes(book.slug) || savedBooks.includes(book.id);
        let bookmarkIcon = isSaved ? 'fas fa-bookmark' : 'far fa-bookmark';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `
        <div class="book-card" data-slug="${book.slug}" data-id="${book.id}">
            <div class="card-img-wrapper">
                <div class="badge-free">FREE</div>
                <div class="bookmark-btn" data-action="bookmark"><i class="${bookmarkIcon}"></i></div>
                <img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false">
            </div>
            <div class="book-details">
                <div class="book-title">${sanitizeHTML(book.title)}</div>
                <div class="book-author">${sanitizeHTML(book.author)}</div>
                <div class="tags-container">
                    <span class="book-tag tag-year">${sanitizeHTML(book.year)}</span>
                    <span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span>
                </div>
            </div>
        </div>`;
    }
    container.insertAdjacentHTML('beforeend', htmlChunk); 
    loadedCount = endIndex;
}

document.getElementById('bookContainer')?.addEventListener('click', (e) => {
    const card = e.target.closest('.book-card');
    if(card) {
        const slug = card.getAttribute('data-slug') || card.getAttribute('data-id');
        const bookmarkBtn = e.target.closest('.bookmark-btn');
        if(bookmarkBtn) toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug); 
        else openDownloadPageLocal(slug);
    }
});

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
    const savedBooksData = booksData.filter(book => savedBooks.includes(book.slug) || savedBooks.includes(book.id));
    
    if (savedBooksData.length === 0) { 
        container.innerHTML = ""; 
        noMsg.style.display = "flex"; 
        return; 
    }
    noMsg.style.display = "none"; 
    let htmlChunk = "";
    savedBooksData.forEach(book => {
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `
        <div class="book-card" data-slug="${book.slug}" data-id="${book.id}">
            <div class="card-img-wrapper">
                <div class="badge-free">FREE</div>
                <div class="bookmark-btn" data-action="bookmark"><i class="fas fa-bookmark"></i></div>
                <img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false">
            </div>
            <div class="book-details">
                <div class="book-title">${sanitizeHTML(book.title)}</div>
                <div class="book-author">${sanitizeHTML(book.author)}</div>
                <div class="tags-container">
                    <span class="book-tag tag-year">${sanitizeHTML(book.year)}</span>
                    <span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = htmlChunk;
}

document.getElementById('savedBooksContainer')?.addEventListener('click', (e) => {
    const card = e.target.closest('.book-card');
    if(card) {
        const slug = card.getAttribute('data-slug') || card.getAttribute('data-id');
        const bookmarkBtn = e.target.closest('.bookmark-btn');
        if(bookmarkBtn) toggleBookmarkLocal(bookmarkBtn.querySelector('i'), slug); 
        else openDownloadPageLocal(slug); 
    }
});

// ==========================================
// MODALS & NAVIGATION
// ==========================================
document.getElementById('open-search')?.addEventListener('click', () => { 
    history.pushState({ popup: 'search' }, ''); 
    document.getElementById('search-box').classList.add('active'); 
    setTimeout(() => { searchInputEl.focus(); }, 300); 
});

document.getElementById('open-noti')?.addEventListener('click', () => { 
    history.pushState({ popup: 'noti' }, ''); 
    document.getElementById('noti-panel').classList.add('active'); 
    
    const blinkDot = document.querySelector('.blink-dot');
    if (blinkDot) blinkDot.style.display = 'none'; 
    
    if (livePosts.length > 0) renderChannelFeed(livePosts, true);
    else renderChannelLoader();
});

if (closeNotiBtn) {
    closeNotiBtn.addEventListener('click', () => {
        if (history.state && history.state.popup === 'noti') history.back();
        else document.getElementById('noti-panel').classList.remove('active');
    });
}

const sidebar = document.getElementById('sidebar'); 
const sidebarOverlay = document.getElementById('sidebar-overlay');
document.getElementById('open-menu')?.addEventListener('click', () => { 
    history.pushState({ popup: 'sidebar' }, ''); 
    sidebar.classList.add('active'); 
    sidebarOverlay.classList.add('active'); 
});
sidebarOverlay?.addEventListener('click', () => { history.back(); });

document.getElementById('menu-dmca')?.addEventListener('click', (e) => { 
    e.preventDefault(); 
    history.pushState({ popup: 'dmca' }, ''); 
    document.getElementById('dmca-panel').classList.add('active'); 
    sidebar.classList.remove('active'); 
    sidebarOverlay.classList.remove('active'); 
});
document.getElementById('close-dmca-btn')?.addEventListener('click', () => { history.back(); });

document.getElementById('menu-bookmarks')?.addEventListener('click', (e) => { 
    e.preventDefault(); 
    history.pushState({ popup: 'bookmarks' }, ''); 
    document.getElementById('bookmarks-panel').classList.add('active'); 
    sidebar.classList.remove('active'); 
    sidebarOverlay.classList.remove('active'); 
    renderSavedBooksUI(); 
});
document.getElementById('close-bookmarks-btn')?.addEventListener('click', () => { history.back(); });

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
    document.getElementById(id)?.classList.add('active'); 
}

function closeAllPanels() { 
    document.getElementById('noti-panel')?.classList.remove('active'); 
    document.getElementById('sidebar')?.classList.remove('active'); 
    document.getElementById('sidebar-overlay')?.classList.remove('active'); 
    document.getElementById('dmca-panel')?.classList.remove('active'); 
    document.getElementById('bookmarks-panel')?.classList.remove('active'); 
    document.getElementById('search-box')?.classList.remove('active'); 
}

window.updateHeaderForTab = function(tab) {
    const headerEl = document.getElementById('main-header');
    const titleEl = document.getElementById('dynamic-header-title');
    const iconsEl = document.getElementById('dynamic-header-icons');
    if (!headerEl) return;
    
    if(tab === 'home') {
        headerEl.style.display = 'flex';
        titleEl.innerText = 'SPIDY BOOK HUB';
        if (iconsEl) iconsEl.style.display = 'flex';
    } else if(tab === 'upload') {
        headerEl.style.display = 'flex';
        titleEl.innerText = 'UPLOAD BOOKS';
        if (iconsEl) iconsEl.style.display = 'none';
    } else if(tab === 'about') {
        headerEl.style.display = 'none';
    }
};

document.getElementById('nav-home')?.addEventListener('click', () => { 
    setNavActive('nav-home'); 
    closeAllPanels(); 
    switchTab('tab-home'); 
    window.updateHeaderForTab('home');
    window.history.replaceState({}, '', window.location.pathname); 
});

document.getElementById('nav-upload')?.addEventListener('click', () => {
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
    setTimeout(() => { checkAndShowUploadTutorialPopup(); }, 300);
});

document.getElementById('nav-dev')?.addEventListener('click', () => { 
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
    if (pdfVirtualObserver) {
        pdfVirtualObserver.disconnect();
        pdfVirtualObserver = null;
    }
    renderedPagesMap.clear();
    currentPdfDocument = null;
    pdfTextCache = [];
    searchMatches = [];
    currentSearchMatchIndex = -1;
    activeSearchKeyword = "";
    
    const searchBar = document.getElementById('pdfSearchBar');
    if (searchBar) searchBar.style.display = 'none';
    const searchInput = document.getElementById('pdfSearchInput');
    if (searchInput) searchInput.value = '';
    const searchCount = document.getElementById('pdfSearchCount');
    if (searchCount) searchCount.innerText = '0/0';
    const badge = document.getElementById('pdfPageBadge');
    if (badge) badge.style.display = 'none';
}

// ==========================================
// 5. HD PDF VIEWER (PINCH-ZOOM & RANGE)
// ==========================================
async function renderPdfInModal(pdfUrl) {
    const scrollContainer = document.getElementById('pdfScrollContainer');
    scrollContainer.innerHTML = `
        <div id="pdfLoadingStatus" style="color: #38bdf8; margin-top: 50px; font-size: 15px; font-weight: 600; text-align: center;">
            <i class="fas fa-spinner fa-spin" style="font-size: 26px; margin-bottom: 12px; display: block;"></i>
            Loading document securely...
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

        const firstPage = await pdf.getPage(1);
        const firstViewport = firstPage.getViewport({ scale: 1.0 });
        const defaultHeight = targetCssWidth * (firstViewport.height / firstViewport.width);

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page-wrapper page-placeholder';
            wrapper.id = `page_wrapper_${pageNum}`;
            wrapper.dataset.pageNum = pageNum;
            wrapper.style.width = `${targetCssWidth}px`;
            wrapper.style.height = `${defaultHeight}px`;
            wrapper.innerHTML = `<span>Page ${pageNum}</span>`;
            scrollContainer.appendChild(wrapper);
        }

        const pageBadge = document.getElementById('pdfPageBadge');
        if (pageBadge) {
            pageBadge.style.display = 'flex';
            pageBadge.style.top = '14%'; 
        }

        initVirtualizationObserver(pdf, targetCssWidth, pixelRatio);

        (async () => {
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                if (!currentPdfDocument) break;
                try {
                    const page = await pdf.getPage(pageNum);
                    const textContent = await page.getTextContent();
                    const rawItems = textContent.items.map(item => item.str);
                    const combinedRaw = rawItems.join(" ");
                    pdfTextCache[pageNum] = {
                        raw: combinedRaw,
                        clean: cleanUnicodeTextForSearch(combinedRaw)
                    };
                } catch(e) {}
            }
        })();

        initPdfScrollTracker();
        initPinchToZoom();

        const savedPage = localStorage.getItem(`last_read_${activeBookSlug}`);
        if (savedPage) {
            const targetPage = parseInt(savedPage, 10);
            if (targetPage > 1 && targetPage <= pdf.numPages) {
                setTimeout(() => { jumpToPdfPage(targetPage); }, 350);
            }
        }

    } catch (err) {
        console.error("PDF Rendering Failed:", err);
        scrollContainer.innerHTML = `
            <div style="color: #ef4444; margin-top: 50px; text-align: center; padding: 25px;">
                <i class="fas fa-triangle-exclamation" style="font-size: 32px; margin-bottom: 12px; display: block;"></i>
                <strong>Failed to load document pages</strong>
                <p style="font-size: 13px; color: #a1a1aa; margin: 10px 0 0 0;">Network interrupted or document unavailable.</p>
            </div>`;
    }
}

function initVirtualizationObserver(pdf, targetCssWidth, pixelRatio) {
    if (pdfVirtualObserver) pdfVirtualObserver.disconnect();

    pdfVirtualObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const pageNum = parseInt(entry.target.dataset.pageNum, 10);
            if (entry.isIntersecting) {
                renderSingleHdPage(pdf, pageNum, targetCssWidth, pixelRatio);
            } else {
                unloadSinglePage(pageNum);
            }
        });
    }, {
        root: document.getElementById('pdfContainer'),
        rootMargin: '700px 0px 700px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        pdfVirtualObserver.observe(wrapper);
    });
}

async function renderSingleHdPage(pdf, pageNum, targetCssWidth, pixelRatio) {
    if (renderedPagesMap.has(pageNum)) return; 
    renderedPagesMap.set(pageNum, true);

    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) return;

    try {
        const page = await pdf.getPage(pageNum);
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const scale = targetCssWidth / unscaledViewport.width;
        const viewport = page.getViewport({ scale: scale });

        wrapper.classList.remove('page-placeholder');
        wrapper.innerHTML = ''; 
        wrapper.style.height = `${viewport.height}px`;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false });
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${targetCssWidth}px`;
        canvas.style.height = `${viewport.height}px`;

        wrapper.appendChild(canvas);

        await page.render({
            canvasContext: context,
            viewport: viewport,
            transform: [pixelRatio, 0, 0, pixelRatio, 0, 0]
        }).promise;

        const textContent = await page.getTextContent();
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.width = `${targetCssWidth}px`;
        textLayerDiv.style.height = `${viewport.height}px`;
        wrapper.appendChild(textLayerDiv);

        if (window.pdfjsLib && window.pdfjsLib.renderTextLayer) {
            await window.pdfjsLib.renderTextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport: viewport,
                textDivs: []
            }).promise;
        }

        if (activeSearchKeyword) {
            highlightMatchesInPage(textLayerDiv, activeSearchKeyword);
        }

    } catch (e) {
        renderedPagesMap.delete(pageNum);
    }
}

function unloadSinglePage(pageNum) {
    if (!renderedPagesMap.has(pageNum)) return;
    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) return;

    wrapper.classList.add('page-placeholder');
    wrapper.innerHTML = `<span>Page ${pageNum}</span>`;
    renderedPagesMap.delete(pageNum);
}

function initPinchToZoom() {
    const container = document.getElementById('pdfContainer');
    const scroller = document.getElementById('pdfScrollContainer');
    if (!container || !scroller) return;

    let currentScale = 1;
    let initialDistance = 0;
    let lastTap = 0;

    container.addEventListener('touchstart', (e) => {
        const now = Date.now();
        if (e.touches.length === 1 && (now - lastTap) < 300) {
            currentScale = 1;
            scroller.style.transform = `scale(1)`;
            return;
        }
        lastTap = now;

        if (e.touches.length === 2) {
            initialDistance = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
        }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialDistance > 0) {
            const currentDistance = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            const factor = currentDistance / initialDistance;
            let newScale = Math.min(Math.max(currentScale * factor, 1), 3.5);
            scroller.style.transform = `scale(${newScale})`;
        }
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        if (e.touches.length < 2 && initialDistance !== 0) {
            const match = scroller.style.transform.match(/scale\(([^)]+)\)/);
            if (match) currentScale = parseFloat(match[1]);
            initialDistance = 0;
        }
    });
}

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

        if (activeBookSlug && currentPageNum > 0) {
            localStorage.setItem(`last_read_${activeBookSlug}`, currentPageNum);
        }

        if (pdfTotalPagesCount > 1 && badgeWrap) {
            const isSearchBarOpen = document.getElementById('pdfSearchBar')?.style.display === 'flex';
            const baseTop = isSearchBarOpen ? 20 : 14; 
            const pageRatio = (currentPageNum - 1) / (pdfTotalPagesCount - 1);
            badgeWrap.style.top = `${baseTop + (pageRatio * 68)}%`;
        }
    }, { passive: true });
}

const pdfPageBadge = document.getElementById('pdfPageBadge');
const goToPageModal = document.getElementById('goToPageModal');
const cancelGoToPageBtn = document.getElementById('cancelGoToPageBtn');
const confirmGoToPageBtn = document.getElementById('confirmGoToPageBtn');
const goToPageInput = document.getElementById('goToPageInput');

pdfPageBadge?.addEventListener('click', () => {
    goToPageInput.value = '';
    goToPageModal.style.display = 'flex';
    goToPageInput.focus();
});

cancelGoToPageBtn?.addEventListener('click', () => { goToPageModal.style.display = 'none'; });
goToPageModal?.addEventListener('click', (e) => {
    if (e.target === goToPageModal) goToPageModal.style.display = 'none';
});
confirmGoToPageBtn?.addEventListener('click', () => { executeGoToPage(); });
goToPageInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') executeGoToPage(); });

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

const pdfSearchToggleBtn = document.getElementById('pdfSearchToggleBtn');
const pdfSearchBar = document.getElementById('pdfSearchBar');
const pdfSearchCloseBtn = document.getElementById('pdfSearchCloseBtn');
const pdfSearchInput = document.getElementById('pdfSearchInput');
const pdfSearchCount = document.getElementById('pdfSearchCount');
const pdfSearchNextBtn = document.getElementById('pdfSearchNextBtn');
const pdfSearchPrevBtn = document.getElementById('pdfSearchPrevBtn');

pdfSearchToggleBtn?.addEventListener('click', () => {
    if (pdfSearchBar.style.display === 'flex') {
        pdfSearchBar.style.display = 'none';
        if (pdfPageBadge) pdfPageBadge.style.top = '14%';
    } else {
        pdfSearchBar.style.display = 'flex';
        if (pdfPageBadge) pdfPageBadge.style.top = '20%';
        pdfSearchInput.focus();
    }
});

pdfSearchCloseBtn?.addEventListener('click', () => {
    pdfSearchBar.style.display = 'none';
    pdfSearchInput.value = '';
    searchMatches = [];
    currentSearchMatchIndex = -1;
    activeSearchKeyword = "";
    pdfSearchCount.innerText = '0/0';
    clearAllHighlights();
    if (pdfPageBadge) pdfPageBadge.style.top = '14%';
});

let pdfSearchTimer;
pdfSearchInput?.addEventListener('input', () => {
    clearTimeout(pdfSearchTimer);
    pdfSearchTimer = setTimeout(() => {
        executePdfTextSearch(pdfSearchInput.value.trim());
    }, 250);
});

function clearAllHighlights() {
    document.querySelectorAll('.highlight-match').forEach(span => {
        span.classList.remove('highlight-match', 'active-focus');
    });
}

function highlightMatchesInPage(textLayerDiv, query) {
    if (!query || !textLayerDiv) return;
    const cleanQ = cleanUnicodeTextForSearch(query);
    const spans = textLayerDiv.querySelectorAll('span');
    spans.forEach(span => {
        const rawText = span.textContent || "";
        const cleanText = cleanUnicodeTextForSearch(rawText);
        if (rawText.toLowerCase().includes(query.toLowerCase()) || (cleanQ && cleanText.includes(cleanQ))) {
            span.classList.add('highlight-match');
        }
    });
}

async function executePdfTextSearch(query) {
    searchMatches = [];
    currentSearchMatchIndex = -1;
    clearAllHighlights();
    activeSearchKeyword = query;

    if (!query || query.length < 1 || !currentPdfDocument) {
        pdfSearchCount.innerText = '0/0';
        return;
    }

    const cleanQuery = cleanUnicodeTextForSearch(query);
    const lowerRawQuery = query.toLowerCase();

    for (let pageNum = 1; pageNum <= pdfTotalPagesCount; pageNum++) {
        let cached = pdfTextCache[pageNum];
        if (!cached) continue;
        const matchFound = cached.raw.toLowerCase().includes(lowerRawQuery) || 
                           (cleanQuery.length > 0 && cached.clean.includes(cleanQuery));
        if (matchFound) searchMatches.push(pageNum);
    }

    document.querySelectorAll('.textLayer').forEach(layer => {
        highlightMatchesInPage(layer, query);
    });

    if (searchMatches.length > 0) {
        currentSearchMatchIndex = 0;
        pdfSearchCount.innerText = `1/${searchMatches.length}`;
        jumpToPdfPage(searchMatches[0]);
    } else {
        pdfSearchCount.innerText = '0/0';
    }
}

pdfSearchNextBtn?.addEventListener('click', () => {
    if (searchMatches.length === 0) return;
    currentSearchMatchIndex = (currentSearchMatchIndex + 1) % searchMatches.length;
    pdfSearchCount.innerText = `${currentSearchMatchIndex + 1}/${searchMatches.length}`;
    jumpToPdfPage(searchMatches[currentSearchMatchIndex]);
});

pdfSearchPrevBtn?.addEventListener('click', () => {
    if (searchMatches.length === 0) return;
    currentSearchMatchIndex = (currentSearchMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    pdfSearchCount.innerText = `${currentSearchMatchIndex + 1}/${searchMatches.length}`;
    jumpToPdfPage(searchMatches[currentSearchMatchIndex]);
});

// ==========================================
// 6. READ ONLINE CONTROLLER
// ==========================================
function openDownloadPageLocal(slugOrId, skipPushState = false) {
    if(!isUserLoggedIn) {
        document.getElementById('loginOverlay').style.display = 'flex'; 
        setTimeout(() => document.getElementById('loginOverlay').style.opacity = '1', 10); 
        return;
    }
    const book = booksData.find(b => b.slug === slugOrId || b.id === slugOrId); 
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
    
    const dlPdfBtn = document.getElementById("dlPdfLinkBtn");
    dlPdfBtn.style.pointerEvents = "auto"; 
    dlPdfBtn.onclick = function(e) { e.preventDefault(); };

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
        
        btn.innerHTML = `<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Ready..`; 
        btn.disabled = true;

        try {
            const rawPdf = book.pdfLink || "";
            const finalPdfUrl = getSecureAssetUrl(rawPdf);

            const title = document.getElementById('pdfViewerTitle');
            title.innerText = sanitizeHTML(book.title);
            document.getElementById('pdfViewerOverlay').style.display = 'flex';
            
            renderPdfInModal(finalPdfUrl);

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

    document.getElementById("pdfContainer")?.addEventListener('contextmenu', event => event.preventDefault());

    let examsArray = (book.exams || "General").split(',').map(item => sanitizeHTML(item.trim()));
    document.getElementById("dlModalTags").innerHTML = examsArray.map(exam => `<div class="dl-modal-tag">${exam}</div>`).join('');
    
    activeBookSlug = book.slug || book.id; 
    activeBookId = book.id;
    activeBookTitle = book.title;
    
    if (!skipPushState) { 
        history.pushState({ popup: 'book' }, '', '?book=' + (book.slug || book.id)); 
    }
}

document.getElementById('closeDlBtn')?.addEventListener('click', closeDownloadPageLocal);
function closeDownloadPageLocal() {
    if (history.state && history.state.popup === 'book') history.back();
    else { 
        document.getElementById("downloadModal").style.display = "none"; 
        window.history.replaceState({}, '', window.location.pathname); 
    }
}

document.getElementById('shareBookBtn')?.addEventListener('click', () => {
    const shareUrl = window.location.origin + window.location.pathname + "?book=" + activeBookSlug;
    if (navigator.share) {
        navigator.share({ title: activeBookTitle, text: "Read this book online", url: shareUrl });
    } else { 
        navigator.clipboard.writeText(shareUrl); 
        showToast("Link Copied!", "success"); 
    }
});

// ==========================================
// 7. DIRECT BOOK UPLOADER (TARGETS REAL /api/generate-upload-url)
// ==========================================
['fileCoverGallery', 'fileCoverBrowse'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', function(e) {
        if(e.target.files.length > 0) {
            selectedCoverFile = e.target.files[0]; 
            e.target.closest('.uc-actions').querySelector('p').innerText = "Selected: " + selectedCoverFile.name;
        }
    });
});

['filePdfGallery', 'filePdfBrowse'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async function(e) {
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
                statusP.innerText = `Selected: ${selectedPdfFile.name} (${detectedFileSizeMB})`;
            }
        }
    });
});

// 🌟 RESOLVES 404 BY HITTING EXACT REPO ENDPOINT: /api/generate-upload-url
function uploadSingleFileTracked(file, type, onProgress) {
    return new Promise(async (resolve, reject) => {
        let detectedMime = file.type;
        if (!detectedMime) {
            detectedMime = type === 'image' ? 'image/jpeg' : 'application/pdf';
        }

        try {
            const userToken = await auth.currentUser.getIdToken(true);
            
            // Exact matching route in multiverse-books/api/
            const authResponse = await fetch('/api/generate-upload-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    fileName: file.name, 
                    fileType: detectedMime, 
                    userToken: userToken,
                    folderType: type === 'image' ? 'covers' : 'pdfs'
                })
            });
            
            if (!authResponse.ok) {
                const errData = await authResponse.json().catch(() => ({}));
                return reject(new Error(errData.error || `Upload URL request failed with status ${authResponse.status}`));
            }

            const authData = await authResponse.json();
            if (!authData.uploadUrl) {
                return reject(new Error("Storage upload URL not provided by server"));
            }

            const xhr = new XMLHttpRequest(); 
            xhr.open("PUT", authData.uploadUrl, true); 
            xhr.setRequestHeader("Content-Type", detectedMime); 

            xhr.upload.addEventListener("progress", (e) => {
                if (e.lengthComputable && onProgress) { 
                    onProgress(e.loaded, e.total);
                }
            });

            xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(authData.fileKey || authData.key);
                } else { 
                    reject(new Error(`Storage rejected upload with status: ${xhr.status}`)); 
                }
            };

            xhr.onerror = function() { 
                reject(new Error("Network / CORS error: Upload to storage failed.")); 
            }; 

            xhr.send(file);

        } catch (error) {
            reject(error);
        }
    });
}

document.getElementById('addBookForm')?.addEventListener('submit', async (e) => {
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
            createdAt: Date.now(), 
            uploaderUid: auth.currentUser.uid 
        };

        await addDoc(collection(db, "books"), newBook);

        const userDocRef = doc(db, "users", auth.currentUser.uid);
        await setDoc(userDocRef, { lastBookUploadTime: Date.now() }, { merge: true });

        percentDisplay.innerHTML = `100<span class="percent-symbol">%</span>`;
        progressFill.style.width = `100%`;
        transferredBytes.innerText = `${totalMB} MB / ${totalMB} MB`;
        speedVal.innerText = "Completed";
        stageTitle.innerText = "Book Published Successfully! ✨";
        stageSub.innerText = "Live and ready for all readers";

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
        showToast(error.message || "Upload Failed! Server connection interrupted.", "error"); 
    }
});

// Admin Tabs Switcher
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
    if (contentArea) contentArea.scrollTop = 0;

    if(tabName === 'add') { 
        document.getElementById('sectionAddBook').classList.add('active'); 
        document.getElementById('admTabAdd').classList.add('active'); 
    } else if(tabName === 'prompt') { 
        document.getElementById('sectionPrompt').classList.add('active'); 
        document.getElementById('admTabPrompt').classList.add('active'); 
    }
}
