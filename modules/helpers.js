// File: modules/helpers.js

import { Timestamp } from "./firebase-config.js";

// ==========================================
// CONSTANTS & ASSET HELPERS
// ==========================================
export const WORKER_PROXY_URL = "https://spidy-proxy.spidybookhub-backend.workers.dev";
export const DEFAULT_AVATAR = "https://i.postimg.cc/D0BF1b77/file-00000000e847207a64f6711d825a859.png";
export const DEFAULT_BOOK_COVER = "https://i.postimg.cc/zBRdPBRy/file-000000002a4c81fb9aaf77416ad909c7.png";

export function getSecureAssetUrl(fileKeyOrUrl) {
    if (!fileKeyOrUrl) return DEFAULT_BOOK_COVER;
    
    const rawStr = fileKeyOrUrl.toString().trim();
    if (!rawStr) return DEFAULT_BOOK_COVER;

    // Handle full external URLs
    if (rawStr.startsWith("http://") || rawStr.startsWith("https://")) {
        // Direct worker proxy URL
        if (rawStr.includes("spidy-proxy.spidybookhub-backend.workers.dev")) {
            return rawStr;
        }
        // Cloudflare R2 bucket endpoint conversion
        if (rawStr.includes(".r2.cloudflarestorage.com")) {
            try {
                const parsed = new URL(rawStr);
                const pathKey = parsed.pathname.replace(/^\/+/, '');
                return `${WORKER_PROXY_URL}/${pathKey}`;
            } catch (e) {
                return rawStr;
            }
        }
        return rawStr;
    }

    // Clean internal relative storage key
    const cleanKey = rawStr.replace(/^\/+/, '');
    if (!cleanKey) return DEFAULT_BOOK_COVER;
    
    return `${WORKER_PROXY_URL}/${cleanKey}`;
}

export function generateCleanSlug(titleStr, fallbackId = "") {
    if (!titleStr) return fallbackId || "book-" + Math.random().toString(36).substring(2, 8);
    const clean = titleStr
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[\s\W-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return clean.length > 0 ? clean : (fallbackId || "book-" + Math.random().toString(36).substring(2, 8));
}

export function getHighQualityAvatar(url) {
    if (!url) return DEFAULT_AVATAR;
    if (url.includes('googleusercontent.com')) {
        return url.replace(/=s\d+(-c)?/g, '=s400-c');
    }
    return url;
}

export function generateDeviceFingerprint(uid = "guest_session") {
    const nav = window.navigator;
    const str = (nav.userAgent || "") + (nav.language || "") + (uid || "guest");
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        let char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}

// ==========================================
// SANITIZATION & SEARCH NORMALIZER
// ==========================================
export function normalizeTextForSearch(str) {
    if (!str) return '';
    return str.toString().toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').trim();
}

export function sanitizeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, function(match) {
        const escape = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
        return escape[match];
    });
}

export function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function stripMarkdown(text) {
    if (!text) return "";
    return text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_~`>]/g, '')
        .replace(/:::copy[\s\S]*?:::/g, '[Code Card]')
        .replace(/\n+/g, ' ')
        .trim();
}

export function parseMarkdown(rawText) {
    if (!rawText) return "";

    let safe = rawText.replace(/:::copy\s*(?:\[(.*?)\])?([\s\S]*?):::/g, function(match, title, content) {
        let lines = (content || "").trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let listHtml = lines.map(line => `<li>${escapeHTML(line.replace(/^[•\-\*]\s*/, ''))}</li>`).join('');
        let copyText = lines.map(line => line.replace(/^[•\-\*]\s*/, '')).join('\n');
        let encodedCopy = encodeURIComponent(copyText);
        let cardTitle = (title || 'Free code').trim();

        return `<div class="tg-copy-card"><div class="tg-copy-header">${escapeHTML(cardTitle)}</div><div class="tg-copy-body"><ul>${listHtml}</ul></div><button type="button" class="tg-copy-action-btn" data-clipboard="${encodedCopy}"><i class="far fa-copy"></i> COPY CODE</button></div>`;
    });

    safe = safe.replace(/(^|\n)(&gt;|>)\s*([\s\S]+?)(?=(\n\n|\n(?!&gt;|>)|$))/g, function(match, prefix, qTag, content) {
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

// ==========================================
// FORMATTERS & TOAST
// ==========================================
export function formatReactionCount(num) {
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

export function formatViewsCount(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

export function normalizeDate(timestamp) {
    if (!timestamp) return new Date();
    if (timestamp instanceof Timestamp) return timestamp.toDate();
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    return new Date(timestamp);
}

export function formatDateDivider(dateObj) {
    return dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function formatTime(dateObj) {
    return dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

let pillToastTimer;
export function showToast(message, type = 'success') {
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
    }, 3200);
}
