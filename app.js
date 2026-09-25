import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { 
    getFirestore, collection, addDoc, doc, updateDoc, onSnapshot, 
    query, orderBy, setDoc, getDoc, getDocs, limit, startAfter, Timestamp 
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
// 2. ASSET RESOLUTION HELPER
// ==========================================
const WORKER_PROXY_URL = "https://spidy-proxy.spidybookhub-backend.workers.dev";
const DEFAULT_AVATAR = "https://i.postimg.cc/D0BF1b77/file-000000000e847207a64f6711d825a859.png";

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

function generateCleanSlug(titleStr, fallbackId = "") {
    if (!titleStr) return fallbackId || "book-" + Math.random().toString(36).substring(2, 8);
    const clean = titleStr
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[\s\W-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return clean.length > 0 ? clean : (fallbackId || "book-" + Math.random().toString(36).substring(2, 8));
}

// ==========================================
// 3. GLOBAL STATE & PAGINATION
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
let selectedCoverFile = null;
let selectedPdfFile = null;
let detectedTotalPages = 0;
let detectedFileSizeMB = "0 MB";

// Dynamic Module Banners
let dynamicBannersList = [];
let activeBannerData = null;
let activeSubjectKey = null;

// Channel Notifications State
let livePosts = [];
let activePost = null;
let isInitialChannelLoad = true;
let unreadPostsCount = 0;

// PDF Engine State
let currentPdfDocument = null;
let pdfTotalPagesCount = 0;
let renderedPagesMap = new Map();
let activeRenderTasks = new Map();
let pdfVirtualObserver = null;
let currentPdfPageInView = 1;
let currentZoomScale = 1.0;
let basePageWidth = 0;
let basePageAspectRatio = 1.414;

// ==========================================
// 4. SANITIZATION & MARKDOWN FORMATTER
// ==========================================
function sanitizeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, function(match) {
        const escape = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
        return escape[match];
    });
}

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getHighQualityAvatar(url) {
    if (!url) return DEFAULT_AVATAR;
    if (url.includes('googleusercontent.com')) {
        return url.replace(/=s\d+(-c)?/g, '=s400-c');
    }
    return url;
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

    let safe = rawText.replace(/:::copy\s*(?:\[(.*?)\])?([\s\S]*?):::/g, function(match, title, content) {
        let lines = (content || "").trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let listHtml = lines.map(line => `<li>${escapeHTML(line.replace(/^[•\-\*]\s*/, ''))}</li>`).join('');
        let copyText = lines.map(line => line.replace(/^[•\-\*]\s*/, '')).join('\n');
        let encodedCopy = encodeURIComponent(copyText);
        let cardTitle = (title || 'Free code').trim();

        return `<div class="tg-copy-card"><div class="tg-copy-header">${escapeHTML(cardTitle)}</div><div class="tg-copy-body"><ul>${listHtml}</ul></div><button type="button" class="tg-copy-action-btn" data-clipboard="${encodedCopy}"><i class="far fa-copy"></i> COPY CODE</button></div>`;
    });

    safe = safe.replace(/(^|\n)(&gt;|>)\s*(.+?)(?=(\n\n|\n(?!&gt;|>)|$))/gs, function(match, prefix, qTag, content) {
        let cleanContent = content.replace(/(^|\n)(&gt;|>)\s*/g, '$1');
        return prefix + `<div class="wa-markdown-quote">${cleanContent}</div>`;
    });

    safe = safe.replace(/\*([^\*]+)\*/g, '<b>$1</b>');
    safe = safe.replace(/_([^_]+)_/g, '<i>$1</i>');
    safe = safe.replace(/~([^~]+)~/g, '<del>$1</del>');
    safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    safe = safe.replace(/\n/g, '<br>');

    safe = safe.replace(/(<div class="tg-copy-card">[\s\S]*?<\/div>)/g, function(m) { return m.replace(/<br>/g, ''); });
    safe = safe.replace(/(<br>\s*)+(<div class="tg-copy-card">)/g, '$2');
    safe = safe.replace(/(<\/div>)\s*(<br>\s*)+/g, '$1');

    if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(safe, {
            ADD_TAGS: ['button', 'i', 'ul', 'li', 'div', 'span', 'b', 'del', 'a'],
            ADD_ATTR: ['target', 'rel', 'class', 'type', 'data-clipboard']
        });
    }
    return safe;
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

let pillToastTimer;
function showToast(message, type = 'success') {
    let toast = document.getElementById('spidyPillToast');
    if (!toast) return;

    clearTimeout(pillToastTimer);
    toast.className = `spidy-pill-toast ${type}`;
    const icon = type === 'success' 
        ? '<i class="fas fa-check-circle"></i>' 
        : '<i class="fas fa-circle-exclamation"></i>';

    toast.innerHTML = `${icon}<span>${sanitizeHTML(message)}</span>`;
    toast.style.display = "flex";
    void toast.offsetWidth;
    toast.classList.add('active');

    pillToastTimer = setTimeout(() => {
        toast.classList.remove('active');
    }, 2800);
}

function generateDeviceFingerprint() {
    const nav = window.navigator;
    const str = nav.userAgent + nav.language + (auth.currentUser ? auth.currentUser.uid : "guest_session");
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

// ==========================================
// 5. PROMO & MODULE CAROUSEL
// ==========================================
let currentPromoIndex = 0;
let promoAutoSlideInterval;

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
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            goToSlide(index);
            startAutoSlide();
        });
    });

    if (prevBtn) {
        prevBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            goToSlide(currentPromoIndex);
            startAutoSlide();
        };
    }

    if (nextBtn) {
        nextBtn.onclick = (e) => {
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
        let diff = startX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 40) {
            if (diff > 0) {
                currentPromoIndex = (currentPromoIndex + 1) % totalSlides;
            } else {
                currentPromoIndex = (currentPromoIndex - 1 + totalSlides) % totalSlides;
            }
            goToSlide(currentPromoIndex);
        }
        startAutoSlide();
    };

    goToSlide(0);
    startAutoSlide();
}

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
    if (modal) {
        history.pushState({ popup: 'moduleBanner' }, '');
        modal.classList.add('active');
    }
};

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
            const safeEncodedKey = encodeURIComponent(rawPdfUrl);
            const encodedTitle = encodeURIComponent(mod.name || "Module Document");

            let pageLabel = "Complete Document";
            if (mod.pages && !mod.pages.includes("180 Pages")) {
                pageLabel = mod.pages.includes("Page") ? mod.pages : `${mod.pages} Pages`;
            }

            html += `
            <div class="module-pdf-card" onclick="window.readModulePdfDirectly(decodeURIComponent('${safeEncodedKey}'), decodeURIComponent('${encodedTitle}'))">
                <div class="module-pdf-badge">
                    <i class="fas fa-file-pdf"></i>
                </div>
                <div class="module-details-wrap">
                    <div class="module-title-h3">${escapeHTML(mod.name || 'Module')}</div>
                    <div class="module-chapters-sub">${escapeHTML(mod.sub || 'Chapters & topics included')}</div>
                    <span class="module-tag-pages"><i class="fas fa-layer-group"></i> ${escapeHTML(pageLabel)}</span>
                </div>
                <i class="fas fa-chevron-right" style="color:rgba(255,255,255,0.25); font-size:0.9rem;"></i>
            </div>`;
        });
        container.innerHTML = html;
    }

    history.pushState({ popup: 'moduleList' }, '');
    document.getElementById('bannerSubjectsView').classList.add('hidden-view');
    document.getElementById('bannerModulesView').classList.remove('hidden-view');
};

window.readModulePdfDirectly = async function(pdfKeyOrUrl, title) {
    if (!isUserLoggedIn || !auth.currentUser) {
        document.getElementById('loginOverlay').style.display = 'flex';
        setTimeout(() => document.getElementById('loginOverlay').style.opacity = '1', 10);
        return;
    }

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

    if (!hasValidToken && !IS_SUPER_ADMIN) {
        history.pushState({ popup: 'tokenModal' }, '');
        document.getElementById('tokenModalOverlay').style.display = 'flex';
        initParticles('particles');
        return;
    }

    const pdfViewer = document.getElementById('pdfViewerOverlay');
    const titleEl = document.getElementById('pdfViewerTitle');

    if (titleEl) titleEl.innerText = title || "Reading Module...";
    if (pdfViewer) {
        history.pushState({ popup: 'pdfViewer', from: 'module' }, '');
        pdfViewer.style.display = 'flex';
    }

    showCenteredPdfLoader("Fetching module manuscript...");

    if (!pdfKeyOrUrl || pdfKeyOrUrl.trim() === "") {
        renderPdfInModal("", true); 
        return;
    }

    try {
        const userToken = await auth.currentUser.getIdToken(false);
        const response = await fetch('/api/get-book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                pdfKey: pdfKeyOrUrl,
                bookSlug: (activeBannerData ? activeBannerData.id : "module-pack"),
                userToken: userToken,
                fingerprint: generateDeviceFingerprint()
            })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            renderPdfInModal(data.pdfLink, true);
        } else {
            renderPdfInModal(getSecureAssetUrl(pdfKeyOrUrl), true);
        }
    } catch (err) {
        renderPdfInModal(getSecureAssetUrl(pdfKeyOrUrl), true);
    }
};

document.getElementById('moduleBackBtn')?.addEventListener('click', () => {
    const modulesView = document.getElementById('bannerModulesView');
    if (modulesView && !modulesView.classList.contains('hidden-view')) {
        if (history.state && history.state.popup === 'moduleList') {
            history.back();
        } else {
            modulesView.classList.add('hidden-view');
            document.getElementById('bannerSubjectsView').classList.remove('hidden-view');
            document.getElementById('moduleHeaderTitle').innerText = (activeBannerData?.title || "MODULE PACK").toUpperCase();
        }
    } else {
        if (history.state && history.state.popup === 'moduleBanner') {
            history.back();
        } else {
            document.getElementById('moduleBannerModal')?.classList.remove('active');
            activeBannerData = null;
            activeSubjectKey = null;
        }
    }
});

// ==========================================
// 6. COMMUNITY POPUP & TUTORIAL POPUP
// ==========================================
let hasClickedWA = false;
let hasClickedTG = false;
let hasClickedIG = false;
let communityPopupTimer = null;

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
            hasClickedWA = true;
            if (waStatus) {
                waStatus.classList.add('completed');
                waStatus.innerHTML = `<span>Done</span> <i class="fas fa-check" style="font-size:11px;"></i>`;
            }
            window.open('https://whatsapp.com/channel/0029Vb6NBZx1yT2GByTTVf2A', '_blank');
            checkAndComplete();
        };
    }

    if (tgCard) {
        tgCard.onclick = (e) => {
            e.preventDefault();
            hasClickedTG = true;
            if (tgStatus) {
                tgStatus.classList.add('completed');
                tgStatus.innerHTML = `<span>Done</span> <i class="fas fa-check" style="font-size:11px;"></i>`;
            }
            window.open('https://t.me/MultiverseBooks', '_blank');
            checkAndComplete();
        };
    }

    if (igCard) {
        igCard.onclick = (e) => {
            e.preventDefault();
            hasClickedIG = true;
            if (igStatus) {
                igStatus.classList.add('completed');
                igStatus.innerHTML = `<span>Done</span> <i class="fas fa-check" style="font-size:11px;"></i>`;
            }
            window.open('https://www.instagram.com/PRINCE_YADAV_3030', '_blank');
            checkAndComplete();
        };
    }

    if (maybeLaterBtn) {
        maybeLaterBtn.onclick = () => {
            if (!hasClickedWA || !hasClickedTG || !hasClickedIG) {
                showToast("Please follow all channels to continue", "error");
                return;
            }
            popup.classList.remove('active');
        };
    }
}

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

document.getElementById('closeUploadPopupBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('uploadPopup')?.classList.add('hidden');
});

// ==========================================
// 7. INITIAL LOADER & DEEP LINKING
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

function checkAndOpenTargetPost() {
    let targetPostId = "";
    const hash = window.location.hash || "";
    if (hash.includes("post/")) {
        targetPostId = hash.split("post/")[1].replace(/[^a-zA-Z0-9_-]/g, '');
    }
    const params = new URLSearchParams(window.location.search);
    if (!targetPostId && params.has("post")) {
        targetPostId = params.get("post");
    }

    if (targetPostId) {
        setTimeout(() => {
            const notiPanel = document.getElementById('noti-panel');
            if (notiPanel && !notiPanel.classList.contains('active')) {
                history.pushState({ popup: 'noti' }, '');
                notiPanel.classList.add('active');
            }
            setTimeout(() => {
                window.scrollToChannelPost(targetPostId);
            }, 500);
        }, 300);
    }
}

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
                    checkAndOpenTargetPost();

                    if (isDeepLinkLoad && pendingBookSlug) {
                        if (isUserLoggedIn) { openDownloadPageLocal(pendingBookSlug, true); } 
                        else {
                            const loginOverlay = document.getElementById('loginOverlay');
                            loginOverlay.style.display = 'flex';
                            setTimeout(() => loginOverlay.style.opacity = '1', 10);
                        }
                    } else {
                        initCommunityDualPopup(); 
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

function syncAndSanitizeBookmarks() {
    if (!booksData || booksData.length === 0) return;
    const existingSlugs = new Set(booksData.map(b => b.slug));
    const existingIds = new Set(booksData.map(b => b.id));
    savedBooks = savedBooks.filter(item => existingSlugs.has(item) || existingIds.has(item));
    localStorage.setItem('spidy_saved_books', JSON.stringify(savedBooks));
}

// ==========================================
// 8. CHANNEL NOTIFICATIONS
// ==========================================
const chatBody = document.getElementById('chatBody');
const contextOverlay = document.getElementById('contextOverlay');
const scrollDownWrapper = document.getElementById('scrollDownWrapper');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const unreadBadge = document.getElementById('unreadBadge');
const closeNotiBtn = document.getElementById('close-noti-btn');

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

function scrollToBottomSmooth() {
    unreadPostsCount = 0;
    if (unreadBadge) {
        unreadBadge.innerText = '0';
        unreadBadge.classList.remove('active');
    }
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
}

if (scrollDownBtn) scrollDownBtn.addEventListener('click', scrollToBottomSmooth);

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
        target.classList.remove('highlight-post');
        void target.offsetWidth;
        target.classList.add('highlight-post');
        setTimeout(() => target.classList.remove('highlight-post'), 2800);
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

        requestAnimationFrame(() => {
            chatBody.scrollTop = chatBody.scrollHeight;
            requestAnimationFrame(() => {
                chatBody.scrollTop = chatBody.scrollHeight;
                chatBody.style.visibility = 'visible';
            });
        });
    } else {
        const prevScrollTop = chatBody.scrollTop;
        chatBody.innerHTML = '';
        chatBody.appendChild(fragment);
        chatBody.scrollTop = prevScrollTop;
    }
}

async function applyReaction(postId, newEmoji) {
    if (!auth.currentUser) return;
    
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

// Global Copy Handler
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
// 9. AUTHENTICATION OBSERVER
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
            const cleanEmail = user.email ? user.email.toLowerCase().trim() : "";
            const adminDocRef = doc(db, "admins", cleanEmail);
            const adminDocSnap = await getDoc(adminDocRef);

            if (adminDocSnap.exists()) {
                IS_SUPER_ADMIN = true;
                document.getElementById('sidebarRoleText').innerText = "Super Admin";
            } else {
                IS_SUPER_ADMIN = false;
                document.getElementById('sidebarRoleText').innerText = "Verified User";
            }
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
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#8b949e; font-weight:700;">No prompts available yet.</div>`; 
            return; 
        }
        snapshot.forEach(docSnap => {
            const data = docSnap.data(); 
            const safeText = sanitizeHTML(data.text);
            const safeInstruction = data.instruction ? sanitizeHTML(data.instruction).replace(/\n/g, "<br>") : "";
            const safeTitle = sanitizeHTML(data.title || "Book Name & Author");
            let instructionHTML = '';
            if(safeInstruction) { 
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

    await loadInitialBooksBatch();

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
            checkAndOpenTargetPost();
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
    });
});

// ==========================================
// 10. REALTIME PAGINATION HANDLER
// ==========================================
async function loadInitialBooksBatch() {
    try {
        const booksRef = collection(db, "books");
        const q = query(booksRef, orderBy("createdAt", "desc"), limit(BATCH_SIZE));
        const snapshot = await getDocs(q);

        booksData = [];
        snapshot.forEach((docSnap) => {
            let data = docSnap.data();
            data.id = docSnap.id;
            if (!data.slug || data.slug.includes('%')) {
                data.slug = generateCleanSlug(data.title, data.id);
            }
            booksData.push(data);
        });

        if (snapshot.docs.length > 0) {
            lastVisibleBookDoc = snapshot.docs[snapshot.docs.length - 1];
            hasMoreBooksToFetch = snapshot.docs.length === BATCH_SIZE;
        } else {
            hasMoreBooksToFetch = false;
        }

        mainFilteredData = [...booksData];
        syncAndSanitizeBookmarks();
        renderStaticFilterPills();
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
        const booksRef = collection(db, "books");
        const q = query(booksRef, orderBy("createdAt", "desc"), startAfter(lastVisibleBookDoc), limit(BATCH_SIZE));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            hasMoreBooksToFetch = false;
            if (infiniteLoader) infiniteLoader.style.display = 'none';
            isFetchingBooksBatch = false;
            return;
        }

        snapshot.forEach((docSnap) => {
            let data = docSnap.data();
            data.id = docSnap.id;
            if (!data.slug || data.slug.includes('%')) {
                data.slug = generateCleanSlug(data.title, data.id);
            }
            booksData.push(data);
        });

        lastVisibleBookDoc = snapshot.docs[snapshot.docs.length - 1];
        hasMoreBooksToFetch = snapshot.docs.length === BATCH_SIZE;
        applyMasterFilter(true);

    } catch (err) {
    } finally {
        isFetchingBooksBatch = false;
        if (!hasMoreBooksToFetch && infiniteLoader) {
            infiniteLoader.style.display = 'none';
        }
    }
}

// ==========================================
// 11. LOGIN & LOGOUT
// ==========================================
function closeLoginOverlayLocal() {
    const loginOverlay = document.getElementById('loginOverlay');
    loginOverlay.style.opacity = '0';
    setTimeout(() => { 
        loginOverlay.style.display = 'none'; 
        if (isDeepLinkLoad && !isUserLoggedIn) {
            isDeepLinkLoad = false;
            window.history.replaceState({}, '', window.location.pathname);
            initCommunityDualPopup(); 
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
    } else { 
        passInput.type = 'password'; 
        eyeIcon.classList.replace('fa-eye-slash', 'fa-eye'); 
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
        btn.innerHTML = originalContent; 
        closeLoginOverlayLocal();
        if (isDeepLinkLoad && pendingBookSlug) {
            document.getElementById('mainAppWrapper').style.display = 'block';
            setTimeout(() => { openDownloadPageLocal(pendingBookSlug, true); }, 300);
        }
    } catch(err) { 
        btn.innerHTML = originalContent; 
    } 
});

document.getElementById('googleSignInBtn')?.addEventListener('click', async () => { 
    const btn = document.getElementById('googleSignInBtn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = `<span style="display:flex; align-items:center; gap:8px;"><i class="fas fa-spinner fa-spin"></i> Connecting...</span>`;
    try { 
        await signInWithPopup(auth, provider); 
        btn.innerHTML = originalContent; 
        closeLoginOverlayLocal();
        if (isDeepLinkLoad && pendingBookSlug) {
            document.getElementById('mainAppWrapper').style.display = 'block';
            setTimeout(() => { openDownloadPageLocal(pendingBookSlug, true); }, 300);
        }
    } catch(err) { 
        btn.innerHTML = originalContent; 
    } 
});

const logoutOverlay = document.getElementById('customLogoutOverlay');
const cancelLogoutBtn = document.getElementById('cancelLogoutBtn');
const confirmLogoutBtn = document.getElementById('confirmLogoutBtn');

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
        } catch (error) {}
    });
}

// ==========================================
// 12. MASTER FILTERS & SEARCH
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
    if (history.state && history.state.popup === 'filter') {
        history.back();
    } else {
        document.getElementById('filterBottomOverlay').classList.remove('active'); 
    }
    applyMasterFilter(); 
});

function normalizeTextForSearch(str) {
    if (!str) return '';
    return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function applyMasterFilter(isAppending = false) {
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
    
    const infiniteLoader = document.getElementById('infinite-loader');
    if (mainFilteredData.length > 0) { 
        document.getElementById('no-results-msg').style.display = 'none'; 
        if(infiniteLoader) infiniteLoader.style.display = hasMoreBooksToFetch ? 'flex' : 'none';
        renderBooksUI(mainFilteredData); 
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
    if (history.state && history.state.popup === 'search') { history.back(); }
});
document.getElementById('openAuthorFilterBtn')?.addEventListener('click', () => { 
    history.pushState({ popup: 'filter' }, '');
    document.getElementById('filterBottomOverlay').classList.add('active'); 
});
document.getElementById('closeAuthorFilterBtn')?.addEventListener('click', () => { 
    if (history.state && history.state.popup === 'filter') {
        history.back();
    } else {
        document.getElementById('filterBottomOverlay').classList.remove('active'); 
    }
});

const infiniteScrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting && hasMoreBooksToFetch && !isFetchingBooksBatch) {
            loadNextBooksBatch();
        }
    });
}, { root: document.getElementById('mainContentArea'), rootMargin: '0px 0px 300px 0px', threshold: 0.1 });

if (document.getElementById('scroll-sentinel')) infiniteScrollObserver.observe(document.getElementById('scroll-sentinel'));

function renderBooksUI(dataToRender) {
    const container = document.getElementById("bookContainer");
    let htmlChunk = "";
    dataToRender.forEach(book => {
        let langClass = (book.lang || "").toLowerCase() === 'hindi' ? 'tag-lang-hindi' : 'tag-lang-english';
        let isSaved = savedBooks.includes(book.slug) || savedBooks.includes(book.id);
        let bookmarkIcon = isSaved ? 'fas fa-bookmark' : 'far fa-bookmark';
        const secureCoverUrl = getSecureAssetUrl(book.image);

        htmlChunk += `<div class="book-card" data-slug="${book.slug}" data-id="${book.id}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="${bookmarkIcon}"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
    });
    container.innerHTML = htmlChunk;
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

        htmlChunk += `<div class="book-card" data-slug="${book.slug}" data-id="${book.id}"><div class="card-img-wrapper"><div class="badge-free">FREE</div><div class="bookmark-btn" data-action="bookmark"><i class="fas fa-bookmark"></i></div><img src="${secureCoverUrl}" loading="lazy" class="book-image" onerror="this.src='${DEFAULT_AVATAR}'" oncontextmenu="return false;" draggable="false"></div><div class="book-details"><div class="book-title">${sanitizeHTML(book.title)}</div><div class="book-author">${sanitizeHTML(book.author)}</div><div class="tags-container"><span class="book-tag tag-year">${sanitizeHTML(book.year)}</span><span class="book-tag ${langClass}">${sanitizeHTML(book.lang)}</span></div></div></div>`;
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
// 13. PANELS & UPLOAD HUB MODAL
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
    
    if (livePosts.length > 0) {
        renderChannelFeed(livePosts, true);
        setTimeout(() => {
            const hasTarget = window.location.hash.includes("post/");
            if (chatBody && !hasTarget) {
                chatBody.scrollTop = chatBody.scrollHeight;
            }
        }, 150);
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
        if (window.location.hash.includes('post/')) {
            history.replaceState(null, '', window.location.pathname);
        }
    });
}

document.getElementById('open-upload-btn')?.addEventListener('click', () => {
    if (!isUserLoggedIn) {
        const loginOverlay = document.getElementById('loginOverlay');
        loginOverlay.style.display = 'flex';
        setTimeout(() => loginOverlay.style.opacity = '1', 10);
        return;
    }

    const uploadModal = document.getElementById('uploadModalOverlay');
    if (uploadModal) {
        history.pushState({ popup: 'uploadModal' }, '');
        uploadModal.classList.add('active');
        checkAndShowUploadTutorialPopup();
    }
});

document.getElementById('closeUploadHubBtn')?.addEventListener('click', () => {
    if (history.state && history.state.popup === 'uploadModal') {
        history.back();
    } else {
        document.getElementById('uploadModalOverlay')?.classList.remove('active');
    }
});

const sidebar = document.getElementById('sidebar'); 
const sidebarOverlay = document.getElementById('sidebar-overlay');
document.getElementById('open-menu')?.addEventListener('click', () => { 
    history.pushState({ popup: 'sidebar' }, ''); 
    sidebar.classList.add('active'); 
    sidebarOverlay.classList.add('active'); 
});
sidebarOverlay?.addEventListener('click', () => { history.back(); });

document.getElementById('menu-home-side')?.addEventListener('click', (e) => {
    e.preventDefault();
    sidebar.classList.remove('active');
    sidebarOverlay.classList.remove('active');
    document.getElementById('mainContentArea')?.scrollTo({ top: 0, behavior: 'smooth' });
});

document.getElementById('menu-bookmarks')?.addEventListener('click', (e) => { 
    e.preventDefault(); 
    history.pushState({ popup: 'bookmarks' }, ''); 
    document.getElementById('bookmarks-panel').classList.add('active'); 
    sidebar.classList.remove('active'); 
    sidebarOverlay.classList.remove('active'); 
    renderSavedBooksUI(); 
});
document.getElementById('close-bookmarks-btn')?.addEventListener('click', () => { history.back(); });

// PDF Viewer Close
window.closePdfViewerDirectly = function() {
    const pdfViewer = document.getElementById('pdfViewerOverlay');
    if (pdfViewer) pdfViewer.style.display = 'none';
    document.getElementById('pdfScrollContainer').innerHTML = ''; 
    const oldLoader = document.getElementById('pdfCenteredLoader');
    if (oldLoader) oldLoader.remove();
    cleanupPdfResources();
    
    if (history.state && history.state.popup === 'pdfViewer') {
        history.back();
    }
};

document.getElementById("closePdfViewerBtn")?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.closePdfViewerDirectly();
});

// POPSTATE LISTENER
window.addEventListener('popstate', (e) => {
    const pdfViewer = document.getElementById('pdfViewerOverlay');
    if (pdfViewer && pdfViewer.style.display === 'flex') {
        pdfViewer.style.display = 'none';
        document.getElementById('pdfScrollContainer').innerHTML = '';
        const oldLoader = document.getElementById('pdfCenteredLoader');
        if (oldLoader) oldLoader.remove();
        cleanupPdfResources();
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
        if (modulesView && !modulesView.classList.contains('hidden-view')) {
            if (history.state && history.state.popup === 'moduleList') {
                return;
            }
            modulesView.classList.add('hidden-view');
            document.getElementById('bannerSubjectsView').classList.remove('hidden-view');
            document.getElementById('moduleHeaderTitle').innerText = (activeBannerData?.title || "MODULE PACK").toUpperCase();
        } else {
            bannerModal.classList.remove('active');
            activeBannerData = null;
            activeSubjectKey = null;
        }
        return;
    }

    const filterOverlay = document.getElementById('filterBottomOverlay');
    if (filterOverlay && filterOverlay.classList.contains('active')) {
        filterOverlay.classList.remove('active');
        return;
    }

    const tokenModal = document.getElementById('tokenModalOverlay');
    if (tokenModal && tokenModal.style.display === 'flex') {
        tokenModal.style.display = 'none';
        return;
    }

    document.getElementById('noti-panel')?.classList.remove('active'); 
    document.getElementById('sidebar')?.classList.remove('active'); 
    document.getElementById('sidebar-overlay')?.classList.remove('active'); 
    document.getElementById('bookmarks-panel')?.classList.remove('active'); 
    document.getElementById('search-box')?.classList.remove('active'); 

    applyMasterFilter();
    const sBook = new URLSearchParams(window.location.search).get('book');
    if(sBook) { 
        openDownloadPageLocal(sBook, true); 
    } else { 
        document.getElementById("downloadModal").style.display = "none";
    }
});

function cleanupPdfResources() {
    if (pdfVirtualObserver) {
        pdfVirtualObserver.disconnect();
        pdfVirtualObserver = null;
    }
    activeRenderTasks.forEach((task) => {
        try { task.cancel(); } catch(e) {}
    });
    activeRenderTasks.clear();
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

function showCenteredPdfLoader(message = "Loading book securely...") {
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
    container.appendChild(loaderDiv);
}

// ==========================================
// 14. ULTRA HD PDF VIEWER (VIRTUALIZED)
// ==========================================
async function renderPdfInModal(pdfUrl, keepExistingLoader = false) {
    const container = document.getElementById('pdfContainer');
    const scrollContainer = document.getElementById('pdfScrollContainer');
    
    if (!keepExistingLoader) {
        showCenteredPdfLoader("Loading book securely...");
    }
    
    scrollContainer.innerHTML = '';
    cleanupPdfResources();

    if (!pdfUrl || pdfUrl.trim() === "" || pdfUrl === "undefined") {
        setTimeout(() => {
            const loaderToDel = document.getElementById('pdfCenteredLoader');
            if (loaderToDel) loaderToDel.remove();
            scrollContainer.innerHTML = `
                <div style="color: #ef4444; margin-top: 140px; text-align: center; padding: 25px;">
                    <i class="fas fa-triangle-exclamation" style="font-size: 38px; margin-bottom: 14px; display: block;"></i>
                    <strong style="font-size: 16px; font-weight: 800;">Failed to load book pages</strong>
                    <p style="font-size: 12.5px; color: #a1a1aa; margin: 8px 0 0 0; font-weight: 500;">Network interrupted or document unavailable.</p>
                </div>`;
        }, 300);
        return;
    }

    try {
        const loadingTask = window.pdfjsLib.getDocument({
            url: pdfUrl,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true
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
        basePageWidth = Math.min(screenWidth - 12, 780);

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
        initPdfScrollTracker();
        initTargetLockedDoubleTapZoom();

        const savedPage = localStorage.getItem(`last_read_${activeBookSlug}`);
        if (savedPage) {
            const targetPage = parseInt(savedPage, 10);
            if (targetPage > 1 && targetPage <= pdf.numPages) {
                setTimeout(() => { jumpToPdfPage(targetPage); }, 350);
            }
        }

    } catch (err) {
        const loaderToDel = document.getElementById('pdfCenteredLoader');
        if (loaderToDel) loaderToDel.remove();

        scrollContainer.innerHTML = `
            <div style="color: #ef4444; margin-top: 140px; text-align: center; padding: 25px;">
                <i class="fas fa-triangle-exclamation" style="font-size: 38px; margin-bottom: 14px; display: block;"></i>
                <strong style="font-size: 16px; font-weight: 800;">Failed to load book pages</strong>
                <p style="font-size: 12.5px; color: #a1a1aa; margin: 8px 0 0 0; font-weight: 500;">Network interrupted or document unavailable.</p>
            </div>`;
    }
}

function initVirtualizationObserver(pdf) {
    if (pdfVirtualObserver) pdfVirtualObserver.disconnect();

    pdfVirtualObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const pageNum = parseInt(entry.target.dataset.pageNum, 10);
            if (entry.isIntersecting) {
                requestAnimationFrame(() => renderSingleHdPage(pdf, pageNum));
            } else {
                unloadSinglePage(pageNum);
            }
        });
    }, {
        root: document.getElementById('pdfContainer'),
        rootMargin: '450px 0px 450px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
        pdfVirtualObserver.observe(wrapper);
    });
}

async function renderSingleHdPage(pdf, pageNum) {
    if (renderedPagesMap.has(pageNum) || activeRenderTasks.has(pageNum)) return; 
    renderedPagesMap.set(pageNum, true);

    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) return;

    try {
        const page = await pdf.getPage(pageNum);
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const currentCssWidth = parseFloat(wrapper.style.width) || basePageWidth;
        const currentScale = currentCssWidth / unscaledViewport.width;
        
        const devicePR = Math.max(window.devicePixelRatio || 1, 2.5);
        const viewport = page.getViewport({ scale: currentScale });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false });
        
        canvas.width = Math.floor(viewport.width * devicePR);
        canvas.height = Math.floor(viewport.height * devicePR);
        canvas.style.width = `100%`;
        canvas.style.height = `100%`;

        wrapper.classList.remove('page-placeholder');
        wrapper.innerHTML = ''; 
        wrapper.appendChild(canvas);

        const renderTask = page.render({
            canvasContext: context,
            viewport: viewport,
            transform: [devicePR, 0, 0, devicePR, 0, 0]
        });

        activeRenderTasks.set(pageNum, renderTask);
        await renderTask.promise;
        activeRenderTasks.delete(pageNum);

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

function unloadSinglePage(pageNum) {
    if (!renderedPagesMap.has(pageNum)) return;
    const wrapper = document.getElementById(`page_wrapper_${pageNum}`);
    if (!wrapper) return;

    if (activeRenderTasks.has(pageNum)) {
        try { activeRenderTasks.get(pageNum).cancel(); } catch(e) {}
        activeRenderTasks.delete(pageNum);
    }

    const canvas = wrapper.querySelector('canvas');
    if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
    }

    wrapper.classList.add('page-placeholder');
    wrapper.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; gap:8px; opacity:0.6;">
            <i class="fas fa-book-open" style="font-size:18px;"></i>
            <span>Page ${pageNum}</span>
        </div>`;
    renderedPagesMap.delete(pageNum);
}

function applyTargetLockedZoom(scaleFactor, targetPageNum) {
    const container = document.getElementById('pdfContainer');
    const scroller = document.getElementById('pdfScrollContainer');
    if (!container || !scroller) return;

    const pageToAnchor = targetPageNum || currentPdfPageInView;
    const targetElement = document.getElementById(`page_wrapper_${pageToAnchor}`);
    const initialOffsetTop = targetElement ? (targetElement.getBoundingClientRect().top - container.getBoundingClientRect().top) : 0;

    currentZoomScale = scaleFactor;
    const newWidth = Math.round(basePageWidth * currentZoomScale);

    if (currentZoomScale > 1.0) {
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

    const wrappers = document.querySelectorAll('.pdf-page-wrapper');
    wrappers.forEach(wrap => {
        const aspect = parseFloat(wrap.dataset.aspectRatio) || basePageAspectRatio;
        wrap.style.width = `${newWidth}px`;
        wrap.style.height = `${Math.round(newWidth * aspect)}px`;
    });

    renderedPagesMap.clear();
    if (currentPdfDocument) {
        initVirtualizationObserver(currentPdfDocument);
    }

    if (targetElement) {
        requestAnimationFrame(() => {
            const newElementTop = targetElement.offsetTop;
            if (currentZoomScale > 1.0) {
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

function initTargetLockedDoubleTapZoom() {
    const container = document.getElementById('pdfContainer');
    if (!container) return;

    let lastTapTime = 0;
    container.addEventListener('touchend', (e) => {
        if (e.changedTouches.length === 1) {
            const now = Date.now();
            if ((now - lastTapTime) < 280) {
                e.preventDefault();
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

function initPdfScrollTracker() {
    const container = document.getElementById('pdfContainer');
    const badge = document.getElementById('pdfCurrentPageNum');
    const badgeWrap = document.getElementById('pdfPageBadge');

    container.addEventListener('scroll', () => {
        const wrappers = container.querySelectorAll('.pdf-page-wrapper');
        const containerCenter = container.getBoundingClientRect().top + (container.clientHeight / 2);

        for (let wrap of wrappers) {
            const rect = wrap.getBoundingClientRect();
            if (rect.top <= containerCenter && rect.bottom >= containerCenter) {
                currentPdfPageInView = parseInt(wrap.dataset.pageNum, 10);
                if (badge && badge.innerText !== wrap.dataset.pageNum) {
                    badge.innerText = wrap.dataset.pageNum;
                }
                break;
            }
        }

        if (activeBookSlug && currentPdfPageInView > 0) {
            localStorage.setItem(`last_read_${activeBookSlug}`, currentPdfPageInView);
        }

        if (pdfTotalPagesCount > 1 && badgeWrap) {
            const pageRatio = (currentPdfPageInView - 1) / (pdfTotalPagesCount - 1);
            badgeWrap.style.top = `${14 + (pageRatio * 68)}%`;
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
    setTimeout(() => {
        goToPageInput.focus();
        // Keyboard visibility positioning
        goToPageModal.scrollTop = 0;
    }, 100);
});
cancelGoToPageBtn?.addEventListener('click', () => { goToPageModal.style.display = 'none'; });
goToPageModal?.addEventListener('click', (e) => {
    if (e.target === goToPageModal) goToPageModal.style.display = 'none';
});
confirmGoToPageBtn?.addEventListener('click', executeGoToPage);
goToPageInput?.addEventListener('keydown', (e) => {
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
    if (targetWrapper) {
        targetWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.getElementById('pdfCurrentPageNum').innerText = pageNum.toString();
        if (pdfTotalPagesCount > 1 && pdfPageBadge) {
            const pageRatio = (pageNum - 1) / (pdfTotalPagesCount - 1);
            pdfPageBadge.style.top = `${14 + (pageRatio * 68)}%`;
        }
    }
}

// ==========================================
// 15. BOOK DETAIL & READ ONLINE
// ==========================================
function openDownloadPageLocal(slugOrId, skipPushState = false) {
    if(!isUserLoggedIn) {
        const loginOverlay = document.getElementById('loginOverlay');
        loginOverlay.style.display = 'flex'; 
        setTimeout(() => loginOverlay.style.opacity = '1', 10); 
        return;
    }
    const book = booksData.find(b => b.slug === slugOrId || b.id === slugOrId); 
    if(!book) return;
    
    const downloadModal = document.getElementById("downloadModal");
    downloadModal.style.display = "flex";
    downloadModal.scrollTop = 0;
    
    const previewImg = document.getElementById("dlPreviewImage");
    previewImg.src = getSecureAssetUrl(book.image); 
    previewImg.onerror = () => { previewImg.src = DEFAULT_AVATAR; };

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
            const loginOverlay = document.getElementById('loginOverlay');
            loginOverlay.style.display = 'flex'; 
            setTimeout(() => loginOverlay.style.opacity = '1', 10); 
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
             history.pushState({ popup: 'tokenModal' }, '');
             document.getElementById('tokenModalOverlay').style.display = 'flex';
             initParticles('particles');
             return; 
        }
        
        btn.innerHTML = `<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Ready..`; 
        btn.disabled = true;

        try {
            const userToken = await auth.currentUser.getIdToken(false);
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
                
                title.innerText = sanitizeHTML(book.title);
                history.pushState({ popup: 'pdfViewer', from: 'book' }, '');
                pdfViewer.style.display = 'flex';
                renderPdfInModal(data.pdfLink);
            } else {
                if (response.status === 401 || (data.error && data.error.includes('Unauthorized'))) {
                    localStorage.removeItem('spidy_secure_session');
                    history.pushState({ popup: 'tokenModal' }, '');
                    document.getElementById('tokenModalOverlay').style.display = 'flex';
                    initParticles('particles');
                } else {
                    showToast(data.error || "Limit reached!", "error");
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
    if (history.state && history.state.popup === 'book') { 
        history.back(); 
    } else { 
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
// 16. REPORT BROKEN LINK
// ==========================================
document.getElementById('reportLinkBtn')?.addEventListener('click', () => {
    document.getElementById('reportModalOverlay').classList.add('active');
});
document.getElementById('closeReportBtn')?.addEventListener('click', () => {
    document.getElementById('reportModalOverlay').classList.remove('active');
});
document.getElementById('reportModalOverlay')?.addEventListener('click', (e) => {
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

submitReportBtn?.addEventListener('click', async () => {
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
        } catch (error) {}

        submitReportBtn.innerHTML = '<i class="fas fa-check-circle"></i> Successfully Reported';
        submitReportBtn.style.background = '#10b981';
        
        setTimeout(() => {
            document.getElementById('reportModalOverlay').classList.remove('active');
            setTimeout(() => {
                submitReportBtn.innerHTML = 'Submit Report';
                submitReportBtn.style.background = '#ef4444';
                submitReportBtn.classList.remove('enabled');
                reportOptions.forEach(o => o.classList.remove('selected'));
            }, 400);
        }, 1200);
    }
});

// ==========================================
// 17. TOKEN VERIFICATION HANDSHAKE
// ==========================================
document.getElementById('closeTokenModalBtn')?.addEventListener('click', () => {
    if (history.state && history.state.popup === 'tokenModal') {
        history.back();
    } else {
        document.getElementById('tokenModalOverlay').style.display = 'none';
    }
});

document.getElementById('tokenInput')?.addEventListener('input', () => {
    document.getElementById('inputBoxWrapperToken').classList.remove('error-state', 'success-state');
});

document.getElementById('getKeyBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('getKeyBtn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Securing Link...';
    btn.style.pointerEvents = 'none';

    try {
        const fp = generateDeviceFingerprint();
        const sessionRes = await fetch('/api/create-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprint: fp })
        });
        const sessionData = await sessionRes.json();

        if (sessionRes.ok && sessionData.success) {
            const { session, sig, ts } = sessionData;
            window.location.href = `https://arolinks.com/6RTf5?session=${encodeURIComponent(session)}&sig=${encodeURIComponent(sig)}&ts=${encodeURIComponent(ts)}`;
        } else {
            window.location.href = "https://arolinks.com/6RTf5";
        }
    } catch (e) {
        window.location.href = "https://arolinks.com/6RTf5";
    } finally {
        setTimeout(() => {
            btn.innerHTML = originalContent;
            btn.style.pointerEvents = 'auto';
        }, 1000);
    }
});

document.getElementById('verifyBtn')?.addEventListener('click', async () => {
    const tokenInput = document.getElementById('tokenInput');
    const tokenValue = tokenInput.value.trim();
    const inputBox = document.getElementById('inputBoxWrapperToken');
    const btn = document.getElementById('verifyBtn');

    inputBox.classList.remove('error-state', 'success-state');
    if (tokenValue.length < 4) {
        inputBox.classList.add('error-state');
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

        if (response.ok && data.success) {
            inputBox.classList.add('success-state');
            showToast('Access Granted! Valid for 10 Days.', 'success');
            
            localStorage.setItem('spidy_secure_session', JSON.stringify({
                token: tokenValue,
                fp: currentFingerprint,
                expiry: Date.now() + (10 * 24 * 60 * 60 * 1000)
            }));

            setTimeout(() => {
                document.getElementById('tokenModalOverlay').style.display = 'none';
                btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
                if (document.getElementById("downloadModal").style.display === "flex") {
                    document.getElementById("dlReadOnlineBtn").click();
                }
            }, 1000);
        } else {
            inputBox.classList.add('error-state');
            showToast(data.error || 'Invalid Token!', 'error');
            btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
        }
    } catch (err) {
        inputBox.classList.add('error-state');
        showToast('Server Error! Cannot verify token.', 'error');
        btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
    }
});

// ==========================================
// 18. NEW UPLOAD HUB & 1-BUTTON SELECTION LOGIC
// ==========================================

function setupDynamicIconWatcher(inputId, wrapperId) {
    const input = document.getElementById(inputId);
    const wrapper = document.getElementById(wrapperId);
    if (!input || !wrapper) return;

    const check = () => {
        if (input.value.trim().length > 0) {
            wrapper.classList.add('has-value');
        } else {
            wrapper.classList.remove('has-value');
        }
    };
    input.addEventListener('input', check);
    input.addEventListener('change', check);
    check();
}

setupDynamicIconWatcher('inTitle', 'wrapTitle');
setupDynamicIconWatcher('inAuthor', 'wrapAuthor');
setupDynamicIconWatcher('inExams', 'wrapExams');

function buildDynamicYearList() {
    const currentYear = new Date().getFullYear();
    const yearOptionsContainer = document.getElementById('yearOptionsList');
    if (!yearOptionsContainer) return;

    document.getElementById('inYear').value = currentYear.toString();
    document.getElementById('selectedYearText').innerText = currentYear.toString();

    let html = '';
    for (let y = currentYear - 5; y <= currentYear; y++) {
        const isActive = y === currentYear ? 'active' : '';
        html += `<div class="popup-select-option ${isActive}" data-year="${y}">${y}</div>`;
    }
    yearOptionsContainer.innerHTML = html;

    document.querySelectorAll('#yearOptionsList .popup-select-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('#yearOptionsList .popup-select-option').forEach(o => o.classList.remove('active'));
            option.classList.add('active');
            const val = option.getAttribute('data-year');
            document.getElementById('inYear').value = val;
            document.getElementById('selectedYearText').innerText = val;
            document.getElementById('yearPopupOverlay').classList.remove('active');
        });
    });
}
buildDynamicYearList();

// White Slider Switcher
const admTabAdd = document.getElementById('admTabAdd');
const admTabPrompt = document.getElementById('admTabPrompt');
const switchTrack = document.getElementById('switchTrack');
const sectionAddBook = document.getElementById('sectionAddBook');
const sectionPrompt = document.getElementById('sectionPrompt');
const uploadContentArea = document.getElementById('admContentArea');

admTabAdd?.addEventListener('click', (e) => {
    e.preventDefault();
    switchTrack.classList.remove('show-prompt');
    admTabAdd.classList.add('active');
    admTabPrompt.classList.remove('active');
    sectionAddBook.classList.add('active');
    sectionPrompt.classList.remove('active');
    if (uploadContentArea) uploadContentArea.scrollTop = 0;
});

admTabPrompt?.addEventListener('click', (e) => {
    e.preventDefault();
    switchTrack.classList.add('show-prompt');
    admTabPrompt.classList.add('active');
    admTabAdd.classList.remove('active');
    sectionPrompt.classList.add('active');
    sectionAddBook.classList.remove('active');
    if (uploadContentArea) uploadContentArea.scrollTop = 0;
});

// Center Modal Selectors
const yearOverlay = document.getElementById('yearPopupOverlay');
const langOverlay = document.getElementById('langPopupOverlay');

document.getElementById('openYearModalBtn')?.addEventListener('click', () => {
    yearOverlay?.classList.add('active');
});
document.getElementById('closeYearModalBtn')?.addEventListener('click', () => {
    yearOverlay?.classList.remove('active');
});
yearOverlay?.addEventListener('click', (e) => {
    if (e.target === yearOverlay) yearOverlay.classList.remove('active');
});

document.getElementById('openLangModalBtn')?.addEventListener('click', () => {
    langOverlay?.classList.add('active');
});
document.getElementById('closeLangModalBtn')?.addEventListener('click', () => {
    langOverlay?.classList.remove('active');
});
langOverlay?.addEventListener('click', (e) => {
    if (e.target === langOverlay) langOverlay.classList.remove('active');
});

document.querySelectorAll('#langOptionsList .popup-select-option').forEach(option => {
    option.addEventListener('click', () => {
        document.querySelectorAll('#langOptionsList .popup-select-option').forEach(o => o.classList.remove('active'));
        option.classList.add('active');
        const val = option.getAttribute('data-lang');
        document.getElementById('inLang').value = val;
        document.getElementById('selectedLangText').innerText = val;
        langOverlay?.classList.remove('active');
    });
});

function autoScrollToElement(el) {
    if (!el || !uploadContentArea) return;
    setTimeout(() => {
        const targetTop = el.offsetTop - 15;
        uploadContentArea.scrollTo({
            top: targetTop,
            behavior: 'smooth'
        });
    }, 180);
}

document.getElementById('fileCoverSelect')?.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        selectedCoverFile = e.target.files[0];
        const coverStatus = document.getElementById('coverStatusText');
        coverStatus.innerText = "Selected: " + selectedCoverFile.name;
        coverStatus.title = "Selected: " + selectedCoverFile.name;
        coverStatus.style.color = '#ffffff';

        const pdfCard = document.getElementById('cardPdfContainer');
        autoScrollToElement(pdfCard);
    }
});

document.getElementById('filePdfSelect')?.addEventListener('change', async (e) => {
    if (e.target.files.length > 0) {
        selectedPdfFile = e.target.files[0];
        const statusText = document.getElementById('pdfStatusText');
        statusText.innerText = `Analyzing: ${selectedPdfFile.name}...`;

        const sizeInMB = (selectedPdfFile.size / (1024 * 1024)).toFixed(2);
        detectedFileSizeMB = `${sizeInMB} MB`;

        const maxAllowed = IS_SUPER_ADMIN ? (1024 * 1024 * 1024) : (250 * 1024 * 1024);
        if (selectedPdfFile.size > maxAllowed) {
            showToast(`File size limit exceed! Max: ${IS_SUPER_ADMIN ? '1GB' : '250MB'}`, "error");
            selectedPdfFile = null;
            statusText.innerText = "Drag & Drop PDF File";
            e.target.value = "";
            return;
        }

        try {
            if (window.pdfjsLib && selectedPdfFile.size < 40 * 1024 * 1024) {
                const arrayBuffer = await selectedPdfFile.arrayBuffer();
                const pdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                detectedTotalPages = pdfDoc.numPages;
            } else {
                detectedTotalPages = "100+";
            }
        } catch (err) {
            detectedTotalPages = "100+";
        }

        const fullLabel = `Selected: ${selectedPdfFile.name}`;
        statusText.innerText = fullLabel;
        statusText.title = fullLabel;
        statusText.style.color = '#ffffff';

        const publishBtn = document.getElementById('publishBtn');
        autoScrollToElement(publishBtn);
    }
});

async function uploadSingleFileTracked(file, type, onProgress) {
    const folderPrefix = type === 'image' ? 'covers' : 'pdfs';
    const fileExt = file.name.split('.').pop().toLowerCase() || (type === 'image' ? 'jpg' : 'pdf');
    const safeFileName = `${folderPrefix}/${Date.now()}_${file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 25)}.${fileExt}`;
    const contentType = type === 'image' ? (file.type || 'image/jpeg') : 'application/pdf';

    const userToken = auth.currentUser ? await auth.currentUser.getIdToken(true) : "";

    if (file.size < 50 * 1024 * 1024) {
        const res = await fetch('/api/generate-upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: safeFileName, fileType: contentType, fileSize: file.size, userToken })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload URL generation error");

        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", data.uploadUrl, true);
            if (file.type) xhr.setRequestHeader("Content-Type", file.type);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
            };
            xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error("Direct upload failed"));
            xhr.onerror = () => reject(new Error("Direct upload network failed"));
            xhr.send(file);
        });
        return data.fileKey;
    }

    const CHUNK_SIZE = 10 * 1024 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const initRes = await fetch('/api/generate-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: "initiateMultipart", fileName: safeFileName, fileType: contentType, fileSize: file.size, userToken })
    });
    const initData = await initRes.json();
    if (!initRes.ok) throw new Error(initData.error || "Multipart initiation failed");

    const uploadId = initData.uploadId;
    const parts = [];
    let uploadedBytes = 0;

    for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);

        const partUrlRes = await fetch('/api/generate-upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: "getPartUrl", fileName: safeFileName, uploadId, partNumber, userToken })
        });
        const partUrlData = await partUrlRes.json();

        const partETag = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", partUrlData.signedUrl, true);
            xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve(xhr.getResponseHeader("ETag") || `part_${partNumber}`) : reject(new Error(`Chunk ${partNumber} failed`));
            xhr.onerror = () => reject(new Error("Network disconnect"));
            xhr.send(chunkBlob);
        });

        parts.push({ PartNumber: partNumber, ETag: partETag });
        uploadedBytes += chunkBlob.size;
        if (onProgress) onProgress(uploadedBytes, file.size);
    }

    const completeRes = await fetch('/api/generate-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: "completeMultipart", fileName: safeFileName, uploadId, parts, userToken })
    });
    const completeData = await completeRes.json();
    return completeData.fileKey;
}

document.getElementById('addBookForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedCoverFile) return showToast("Cover Image select karein!", "error");
    if (!selectedPdfFile) return showToast("PDF File select karein!", "error");

    const pipeline = document.getElementById('uploadPipelineOverlay');
    const percentDisplay = document.getElementById('syncPercentDisplay');
    const progressFill = document.getElementById('syncProgressFill');
    const transferredBytes = document.getElementById('syncTransferredBytes');
    const speedVal = document.getElementById('syncSpeedVal');
    const stageTitle = document.getElementById('syncStageTitle');
    const liveCoverImg = document.getElementById('syncLiveCoverImg');
    const defaultCoverIcon = document.getElementById('syncDefaultCoverIcon');

    const inputTitle = document.getElementById('inTitle').value.trim() || selectedPdfFile.name;
    document.getElementById('syncDynamicTitle').innerText = inputTitle;
    document.getElementById('syncDynamicPdfSize').innerText = `PDF Size: ${(selectedPdfFile.size / (1024 * 1024)).toFixed(2)} MB`;

    const reader = new FileReader();
    reader.onload = (evt) => {
        liveCoverImg.src = evt.target.result;
        liveCoverImg.style.display = 'block';
        defaultCoverIcon.style.display = 'none';
    };
    reader.readAsDataURL(selectedCoverFile);

    const totalBytes = selectedCoverFile.size + selectedPdfFile.size;
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
    let coverLoaded = 0, pdfLoaded = 0, lastLoaded = 0, lastTime = Date.now();

    pipeline.style.display = 'flex';

    function updateTelemetry() {
        const loaded = coverLoaded + pdfLoaded;
        const percent = Math.min(98, Math.floor((loaded / totalBytes) * 98));
        percentDisplay.innerHTML = `${percent}<span class="percent-symbol">%</span>`;
        progressFill.style.width = `${percent}%`;
        transferredBytes.innerText = `${(loaded / (1024 * 1024)).toFixed(2)} MB / ${totalMB} MB`;

        const now = Date.now();
        const diff = (now - lastTime) / 1000;
        if (diff >= 0.5) {
            speedVal.innerText = `${(((loaded - lastLoaded) / (1024 * 1024)) / diff).toFixed(1)} MB/s`;
            lastLoaded = loaded;
            lastTime = now;
        }
    }

    try {
        stageTitle.innerText = "Cover Artwork Transfer...";
        const coverKey = await uploadSingleFileTracked(selectedCoverFile, 'image', (l) => { coverLoaded = l; updateTelemetry(); });

        stageTitle.innerText = "Uploading PDF Manuscript...";
        const pdfKey = await uploadSingleFileTracked(selectedPdfFile, 'pdf', (l) => { pdfLoaded = l; updateTelemetry(); });

        stageTitle.innerText = "Database me register ho raha hai...";
        percentDisplay.innerHTML = `99<span class="percent-symbol">%</span>`;
        progressFill.style.width = `99%`;

        let baseSlug = generateCleanSlug(inputTitle);
        let finalSlug = baseSlug;
        const isDuplicate = booksData.some(b => b.slug === finalSlug);
        if (isDuplicate) {
            finalSlug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;
        }

        const newBook = {
            title: inputTitle,
            author: document.getElementById('inAuthor').value,
            year: document.getElementById('inYear').value,
            lang: document.getElementById('inLang').value,
            exams: document.getElementById('inExams').value,
            slug: finalSlug,
            image: coverKey,
            pdfLink: pdfKey,
            fileSize: detectedFileSizeMB,
            sizeBytes: selectedPdfFile.size,
            fileFormat: "PDF",
            totalPages: detectedTotalPages.toString(),
            dateAdded: new Date().toLocaleDateString('en-GB').toUpperCase(),
            createdAt: Date.now(),
            uploaderUid: auth.currentUser ? auth.currentUser.uid : "anonymous"
        };

        const docRef = await addDoc(collection(db, "books"), newBook);
        newBook.id = docRef.id;
        booksData.unshift(newBook);
        applyMasterFilter();

        percentDisplay.innerHTML = `100<span class="percent-symbol">%</span>`;
        progressFill.style.width = `100%`;
        stageTitle.innerText = "Book Published Successfully! ✨";

        setTimeout(() => {
            pipeline.style.display = 'none';
            e.target.reset();
            selectedCoverFile = null;
            selectedPdfFile = null;
            
            document.getElementById('coverStatusText').innerText = "Drag & Drop Cover Image";
            document.getElementById('coverStatusText').title = "Drag & Drop Cover Image";
            document.getElementById('pdfStatusText').innerText = "Drag & Drop PDF File";
            document.getElementById('pdfStatusText').title = "Drag & Drop PDF File";

            ['wrapTitle', 'wrapAuthor', 'wrapExams'].forEach(id => {
                document.getElementById(id)?.classList.remove('has-value');
            });

            showToast("Book Published Successfully!", "success");
            
            if (history.state && history.state.popup === 'uploadModal') {
                history.back();
            } else {
                document.getElementById('uploadModalOverlay')?.classList.remove('active');
            }
        }, 1200);

    } catch (error) {
        pipeline.style.display = 'none';
        showToast(error.message || "Upload Failed!", "error");
    }
});
