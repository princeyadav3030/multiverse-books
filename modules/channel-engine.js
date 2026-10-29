// File: ./modules/channel-engine.js

import { 
    auth, db, collection, query, orderBy, onSnapshot 
} from "./firebase-config.js";

import { 
    getSecureAssetUrl, sanitizeHTML, stripMarkdown, parseMarkdown, 
    formatViewsCount, formatTime, formatDateDivider, normalizeDate, 
    showToast, formatReactionCount 
} from "./helpers.js";

import { triggerLoginModal } from "./auth-system.js";

// ==========================================
// CONFIGURATION
// ==========================================
const SPIDY_API_WORKER_URL = "https://spidy-api.spidybookhub.workers.dev";

// ==========================================
// CHANNEL INTERNAL STATE
// ==========================================
export let livePosts = [];
let renderedPostsCount = 0;
const CHANNEL_BATCH_SIZE = 15;
let isLoadingOlderPosts = false;
let activePost = null;
let isInitialChannelLoad = true;
let unreadPostsCount = 0;
let postViewObserver = null;

// Target Deeplink Post State
export let pendingTargetPostId = "";

// Resolve post ID from current URL (hash or query param)
function resolveTargetPostFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash || "";
    if (hash.includes("post/")) {
        return hash.split("post/")[1].replace(/[^a-zA-Z0-9_-]/g, '');
    } else if (urlParams.has("post")) {
        return urlParams.get("post").replace(/[^a-zA-Z0-9_-]/g, '');
    }
    return "";
}

pendingTargetPostId = resolveTargetPostFromUrl();

// DOM Elements
const chatBody = document.getElementById('chatBody');
const contextOverlay = document.getElementById('contextOverlay');
const scrollDownWrapper = document.getElementById('scrollDownWrapper');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const unreadBadge = document.getElementById('unreadBadge');

// ==========================================
// 1. HELPERS & SCROLL CONTROLLERS
// ==========================================
export function renderChannelLoader() {
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

function getUserReaction(postId) { 
    const uid = auth.currentUser ? auth.currentUser.uid : 'guest';
    return localStorage.getItem(`reaction_${uid}_${postId}`); 
}

function setUserReaction(postId, emoji) {
    const uid = auth.currentUser ? auth.currentUser.uid : 'guest';
    const key = `reaction_${uid}_${postId}`;
    if (emoji) localStorage.setItem(key, emoji);
    else localStorage.removeItem(key);
}

export function forceScrollChatToBottom() {
    if (!chatBody) return;
    unreadPostsCount = 0;
    if (unreadBadge) {
        unreadBadge.innerText = '0';
        unreadBadge.classList.remove('active');
    }
    if (scrollDownWrapper) {
        scrollDownWrapper.classList.remove('show');
    }
    chatBody.scrollTop = chatBody.scrollHeight - chatBody.clientHeight;
}

export function scrollToBottomSmooth() {
    if (!chatBody) return;
    unreadPostsCount = 0;
    if (unreadBadge) {
        unreadBadge.innerText = '0';
        unreadBadge.classList.remove('active');
    }
    const targetTop = chatBody.scrollHeight - chatBody.clientHeight;
    chatBody.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
}

// Global window function for smooth scroll + luxury glow
window.scrollToChannelPost = function(postId) {
    if (!postId) return;
    
    // Ensure target element is rendered in DOM even if it belongs to older batch
    let target = document.getElementById(`post_${postId}`);
    if (!target && livePosts && livePosts.length > 0) {
        renderChannelFeed(livePosts, false, postId);
        target = document.getElementById(`post_${postId}`);
    }

    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('highlight-post');
        void target.offsetWidth; // Force Reflow
        target.classList.add('highlight-post');
        setTimeout(() => target.classList.remove('highlight-post'), 2900);
    }
};

// ==========================================
// 2. REACTIONS & STABLE SORTING (TELEGRAM SPEC)
// ==========================================
function buildReactionsHTML(reactionsObj, userSelectedEmoji) {
    if (!reactionsObj) return '';

    // Telegram Sorting: Count (High to Low), tie-breaker maintains stable position
    const sortedReactions = Object.entries(reactionsObj)
        .filter(([_, count]) => count > 0)
        .sort((a, b) => {
            if (b[1] !== a[1]) {
                return b[1] - a[1];
            }
            return 0; // Stable order if counts are equal
        });

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

export function updateReactionInDOM(postId, changedEmoji = null, direction = 'up') {
    const post = livePosts.find(p => p.id === postId);
    const bubble = document.getElementById(`post_${postId}`);
    if (!post || !bubble) return;

    const userSelectedEmoji = getUserReaction(postId);
    const reactionsContainer = bubble.querySelector('.inline-reactions');
    if (!reactionsContainer) return;

    if (changedEmoji) {
        const pill = reactionsContainer.querySelector(`.reaction-pill[data-emoji="${changedEmoji}"]`);
        if (pill) {
            const countEl = pill.querySelector('.count');
            const newCount = post.reactions?.[changedEmoji] || 0;
            
            if (newCount > 0 && countEl) {
                countEl.innerText = formatReactionCount(newCount);
                countEl.classList.remove('count-roll-up', 'count-roll-down');
                void countEl.offsetWidth;
                countEl.classList.add(direction === 'up' ? 'count-roll-up' : 'count-roll-down');

                pill.classList.remove('bump-emoji');
                void pill.offsetWidth;
                pill.classList.add('bump-emoji');

                if (userSelectedEmoji === changedEmoji) pill.classList.add('active');
                else pill.classList.remove('active');
            }
        }
    }

    // Refresh layout order after count mutation
    reactionsContainer.innerHTML = buildReactionsHTML(post.reactions, userSelectedEmoji);
    reactionsContainer.querySelectorAll('.reaction-pill').forEach(pill => {
        pill.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyReaction(post.id, pill.dataset.emoji);
        });
    });
}

export async function applyReaction(postId, newEmoji) {
    if (!auth.currentUser) {
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
            updateReactionInDOM(postId, existing, 'down');
        }
        livePosts[pIdx].reactions[newEmoji] = (livePosts[pIdx].reactions[newEmoji] || 0) + 1;
        updateReactionInDOM(postId, newEmoji, 'up');
    }
    if (navigator.vibrate) navigator.vibrate(15);

    try {
        const token = await auth.currentUser.getIdToken(false);
        const res = await fetch(`${SPIDY_API_WORKER_URL}/api/channel-action`, {
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

// ==========================================
// 3. POST VIEWS OBSERVER
// ==========================================
async function registerUniqueView(postId) {
    if (!auth.currentUser || !postId) return;
    const uid = auth.currentUser.uid;
    const viewKey = `viewed_post_${uid}_${postId}`;
    
    if (localStorage.getItem(viewKey)) return;

    try {
        localStorage.setItem(viewKey, '1');
        const token = await auth.currentUser.getIdToken(false);
        await fetch(`${SPIDY_API_WORKER_URL}/api/channel-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'view', postId, userToken: token })
        });
    } catch (err) {}
}

function initPostViewObserver() {
    if (postViewObserver) postViewObserver.disconnect();
    postViewObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const postId = entry.target.dataset.postId;
                if (postId) registerUniqueView(postId);
            }
        });
    }, { threshold: 0.5 });
}

// ==========================================
// 4. RENDERING PIPELINE & DOM CREATION
// ==========================================
function createSinglePostElement(post) {
    const dateObj = normalizeDate(post.createdAt);
    const userSelectedEmoji = getUserReaction(post.id);
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.id = `post_${post.id}`;
    bubble.dataset.postId = post.id;

    let quoteElement = null;
    if (post.quote) {
        const targetId = post.quote.targetPostId || '';
        const cleanSnippet = sanitizeHTML(stripMarkdown(post.quote.text || ''));
        quoteElement = document.createElement('div');
        quoteElement.className = 'msg-quote';
        quoteElement.innerHTML = `
            <div class="quote-author">SPIDY BOOK HUB</div>
            <div class="quote-text">${cleanSnippet}</div>
        `;
        if (targetId) {
            quoteElement.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.scrollToChannelPost(targetId);
            });
        }
    }

    let imageHTML = post.imageUrl 
        ? `<img src="${getSecureAssetUrl(post.imageUrl)}" class="msg-image" alt="Post Image" onerror="this.style.display='none';">` 
        : '';

    const reactionPillsHTML = buildReactionsHTML(post.reactions, userSelectedEmoji);

    bubble.innerHTML = `
        ${imageHTML}
        <div class="msg-text">${parseMarkdown(post.text)}</div>
        <div class="post-footer">
            <div class="inline-reactions">${reactionPillsHTML}</div>
            <div class="msg-meta">
                <i class="fas fa-eye"></i> ${formatViewsCount(post.views || 1)} &nbsp; ${formatTime(dateObj)}
            </div>
        </div>
    `;

    if (quoteElement) {
        bubble.prepend(quoteElement);
    }

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
            e.target.closest('.tg-copy-card') ||
            e.target.closest('.msg-quote')
        ) {
            return;
        }
        if (!auth.currentUser) {
            triggerLoginModal();
            return;
        }
        activePost = post;
        if (contextOverlay) {
            history.pushState({ popup: 'channelContext' }, '');
            contextOverlay.classList.add('show');
        }
        if (navigator.vibrate) navigator.vibrate(20);
    });

    if (postViewObserver) postViewObserver.observe(bubble);
    return bubble;
}

export function renderChannelFeed(postsToRender = null, isInitialOrPanelOpen = false, targetPostId = "") {
    if (!chatBody) return;

    const posts = Array.isArray(postsToRender) ? postsToRender : livePosts;

    if (!posts || posts.length === 0) {
        chatBody.innerHTML = `
            <div class="empty-loading">
                <i class="fas fa-bullhorn" style="font-size:26px; color:var(--text-secondary); opacity:0.6;"></i>
                No channel updates posted yet.
            </div>`;
        return;
    }

    initPostViewObserver();
    chatBody.innerHTML = '';
    const fragment = document.createDocumentFragment();

    const topLoader = document.createElement('div');
    topLoader.id = 'topHistoryLoader';
    topLoader.className = 'top-history-loader';
    topLoader.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Loading older messages...`;
    fragment.appendChild(topLoader);

    const total = posts.length;
    let startIndex = Math.max(0, total - CHANNEL_BATCH_SIZE);

    if (targetPostId) {
        const targetIdx = posts.findIndex(p => p.id === targetPostId);
        if (targetIdx !== -1 && targetIdx < startIndex) {
            startIndex = Math.max(0, targetIdx - 3);
        }
    }

    const initialBatch = posts.slice(startIndex, total);
    renderedPostsCount = initialBatch.length;

    let lastDateStr = '';
    initialBatch.forEach(post => {
        const dateObj = normalizeDate(post.createdAt);
        const dateStr = formatDateDivider(dateObj);

        if (dateStr !== lastDateStr) {
            const divider = document.createElement('div');
            divider.className = 'date-divider';
            divider.innerText = dateStr;
            fragment.appendChild(divider);
            lastDateStr = dateStr;
        }

        fragment.appendChild(createSinglePostElement(post));
    });

    chatBody.appendChild(fragment);

    if (isInitialOrPanelOpen && !targetPostId) {
        requestAnimationFrame(() => {
            forceScrollChatToBottom();
        });
    }
}

export function loadOlderChannelPosts() {
    if (isLoadingOlderPosts || renderedPostsCount >= livePosts.length) return;
    isLoadingOlderPosts = true;

    const topLoader = document.getElementById('topHistoryLoader');
    if (topLoader) topLoader.classList.add('active');

    setTimeout(() => {
        const total = livePosts.length;
        const currentStartIndex = total - renderedPostsCount;
        const newStartIndex = Math.max(0, currentStartIndex - CHANNEL_BATCH_SIZE);
        const olderBatch = livePosts.slice(newStartIndex, currentStartIndex);

        if (olderBatch.length === 0) {
            if (topLoader) topLoader.classList.remove('active');
            isLoadingOlderPosts = false;
            return;
        }

        const prevScrollHeight = chatBody.scrollHeight;
        const prevScrollTop = chatBody.scrollTop;

        const fragment = document.createDocumentFragment();
        let lastDateStr = '';

        olderBatch.forEach(post => {
            const dateObj = normalizeDate(post.createdAt);
            const dateStr = formatDateDivider(dateObj);

            if (dateStr !== lastDateStr) {
                const divider = document.createElement('div');
                divider.className = 'date-divider';
                divider.innerText = dateStr;
                fragment.appendChild(divider);
                lastDateStr = dateStr;
            }
            fragment.appendChild(createSinglePostElement(post));
        });

        if (topLoader && topLoader.nextSibling) {
            chatBody.insertBefore(fragment, topLoader.nextSibling);
        } else {
            chatBody.prepend(fragment);
        }

        renderedPostsCount += olderBatch.length;
        if (topLoader) topLoader.classList.remove('active');

        const heightDifference = chatBody.scrollHeight - prevScrollHeight;
        chatBody.scrollTop = prevScrollTop + heightDifference;

        isLoadingOlderPosts = false;
    }, 250);
}

// ==========================================
// 5. DEEP-LINK CHECK & AUTO OPEN
// ==========================================
export function checkAndOpenTargetPost() {
    const targetId = pendingTargetPostId || resolveTargetPostFromUrl();
    if (!targetId) return;

    if (!auth.currentUser) {
        triggerLoginModal();
        return;
    }

    const notiPanel = document.getElementById('noti-panel');
    if (!notiPanel) return;

    if (!notiPanel.classList.contains('active')) {
        history.pushState({ popup: 'noti' }, '');
        notiPanel.classList.add('active');
    }

    const blinkDot = document.querySelector('.blink-dot');
    if (blinkDot) blinkDot.style.display = 'none';

    if (livePosts.length > 0) {
        renderChannelFeed(livePosts, false, targetId);
    }

    setTimeout(() => {
        window.scrollToChannelPost(targetId);
        pendingTargetPostId = "";
    }, 450);
}

// Helper: Universal Robust Clipboard Copy (NO CUSTOM TOAST OVERLAY)
function copyTextToClipboard(rawText, btnElement = null) {
    if (!rawText) return;
    
    function onSuccess() {
        if (btnElement) {
            const originalHTML = btnElement.innerHTML;
            btnElement.classList.add('copied-active');
            btnElement.innerHTML = `<i class="fas fa-check"></i> COPIED!`;
            setTimeout(() => {
                btnElement.classList.remove('copied-active');
                btnElement.innerHTML = originalHTML;
            }, 2000);
        }
    }

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(rawText).then(onSuccess).catch(() => {
            fallbackExecCopy(rawText, onSuccess);
        });
    } else {
        fallbackExecCopy(rawText, onSuccess);
    }
}

function fallbackExecCopy(text, callback) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        if (callback) callback();
    } catch (err) {}
    document.body.removeChild(textArea);
}

// ==========================================
// 6. INITIALIZATION & GLOBAL LISTENERS
// ==========================================
export function initChannelEngine() {
    if (scrollDownBtn) scrollDownBtn.addEventListener('click', scrollToBottomSmooth);

    // Global Event Delegation for ALL "COPY CODE" buttons (Prompts + Channel Posts)
    document.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('.telegram-copy-btn, .tg-copy-action-btn');
        if (copyBtn) {
            e.preventDefault();
            e.stopPropagation();

            let textToCopy = "";
            if (copyBtn.dataset.clipboard) {
                try {
                    textToCopy = decodeURIComponent(copyBtn.dataset.clipboard);
                } catch(err) {
                    textToCopy = copyBtn.dataset.clipboard;
                }
            } else {
                const parentCard = copyBtn.closest('.tg-copy-card, .telegram-prompt-card');
                if (parentCard) {
                    const bodyEl = parentCard.querySelector('.tg-copy-body, .telegram-prompt-body');
                    if (bodyEl) textToCopy = bodyEl.innerText.trim();
                }
            }

            if (textToCopy) {
                copyTextToClipboard(textToCopy, copyBtn);
            }
        }
    });

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

            if (chatBody.scrollTop < 60 && !isLoadingOlderPosts && renderedPostsCount < livePosts.length) {
                loadOlderChannelPosts();
            }
        }, { passive: true });
    }

    if (contextOverlay) {
        contextOverlay.addEventListener('click', (e) => {
            if (e.target === contextOverlay) {
                if (history.state && history.state.popup === 'channelContext') {
                    history.back();
                } else {
                    contextOverlay.classList.remove('show');
                }
            }
        });

        document.querySelectorAll('.cm-emoji').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const emoji = el.getAttribute('data-emoji');
                if (activePost && emoji) {
                    applyReaction(activePost.id, emoji);
                    if (history.state && history.state.popup === 'channelContext') {
                        history.back();
                    } else {
                        contextOverlay.classList.remove('show');
                    }
                    activePost = null;
                }
            });
        });

        document.getElementById('cmCopyText')?.addEventListener('click', () => {
            if (!activePost) return;
            copyTextToClipboard(stripMarkdown(activePost.text));
            if (history.state && history.state.popup === 'channelContext') history.back();
            else contextOverlay.classList.remove('show');
        });

        document.getElementById('cmCopyLink')?.addEventListener('click', () => {
            if (!activePost) return;
            const cleanBase = window.location.origin + window.location.pathname;
            const url = `${cleanBase}#/post/${activePost.id}`;
            copyTextToClipboard(url);
            if (history.state && history.state.popup === 'channelContext') history.back();
            else contextOverlay.classList.remove('show');
        });

        document.getElementById('cmForward')?.addEventListener('click', () => {
            if (!activePost) return;
            const cleanBase = window.location.origin + window.location.pathname;
            const url = `${cleanBase}#/post/${activePost.id}`;
            const cleanText = stripMarkdown(activePost.text);
            if (navigator.share) {
                navigator.share({ title: 'SPIDY BOOK HUB', text: cleanText, url: url }).catch(() => {});
            } else {
                copyTextToClipboard(url);
            }
            if (history.state && history.state.popup === 'channelContext') history.back();
            else contextOverlay.classList.remove('show');
        });

        document.getElementById('cmReport')?.addEventListener('click', () => {
            if (history.state && history.state.popup === 'channelContext') history.back();
            else contextOverlay.classList.remove('show');
        });
    }

    // Prompts Realtime Sync
    onSnapshot(query(collection(db, "prompts"), orderBy("createdAt", "asc")), (snapshot) => {
        const container = document.getElementById('promptsContainer');
        if (!container) return;
        container.innerHTML = '';
        if (snapshot.empty) { 
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#8b949e; font-weight:700;">No prompts available yet.</div>`; 
            return; 
        }
        let aggregatedHTML = '';
        snapshot.forEach(docSnap => {
            const data = docSnap.data(); 
            const safeText = sanitizeHTML(data.text);
            const safeInstruction = data.instruction ? sanitizeHTML(data.instruction).replace(/\n/g, "<br>") : "";
            const safeTitle = sanitizeHTML(data.title || "Book Name & Author");
            let instructionHTML = '';
            if (safeInstruction) { 
                instructionHTML = `<div class="prompt-instruction-text">${safeInstruction}</div>`; 
            }
            aggregatedHTML += `
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
        container.innerHTML = aggregatedHTML;
    });

    // Channel Posts Realtime Sync
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

        if (isInitialChannelLoad) {
            renderChannelFeed(livePosts, !pendingTargetPostId, pendingTargetPostId);
            isInitialChannelLoad = false;
            if (pendingTargetPostId) {
                checkAndOpenTargetPost();
            }
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
                renderChannelFeed(livePosts, !pendingTargetPostId, pendingTargetPostId);
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
}
