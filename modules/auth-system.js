// File: modules/auth-system.js

import { 
    auth, provider, db, doc, getDoc, setDoc, 
    signInWithEmailAndPassword, sendPasswordResetEmail, 
    signInWithPopup, signOut, syncUserProfileToFirestore 
} from "./firebase-config.js";
import { showToast, generateDeviceFingerprint } from "./helpers.js";

// ==========================================
// LOGIN MODAL CONTROLS
// ==========================================
export function triggerLoginModal() {
    const loginOverlay = document.getElementById('loginOverlay');
    if (loginOverlay) {
        loginOverlay.style.display = 'flex';
        setTimeout(() => loginOverlay.style.opacity = '1', 10);
    }
}

export function closeLoginOverlayLocal() {
    const loginOverlay = document.getElementById('loginOverlay');
    if (!loginOverlay) return;
    loginOverlay.style.opacity = '0';
    setTimeout(() => { 
        loginOverlay.style.display = 'none'; 
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('book') && !auth.currentUser) {
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, 500);
}

// ==========================================
// LOGOUT CONTROLS
// ==========================================
export function openLogoutDialog() {
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('active');
    if (sidebarOverlay) sidebarOverlay.classList.remove('active');

    const logoutOverlay = document.getElementById('customLogoutOverlay');
    if (logoutOverlay) {
        logoutOverlay.style.display = 'flex';
        void logoutOverlay.offsetWidth;
        logoutOverlay.classList.add('show');
    }
}

export function closeLogoutDialog() {
    const logoutOverlay = document.getElementById('customLogoutOverlay');
    if (logoutOverlay) { 
        logoutOverlay.classList.remove('show'); 
        setTimeout(() => {
            logoutOverlay.style.display = 'none';
        }, 250); 
    } 
}

// ==========================================
// TOKEN MODAL CONTROLS
// ==========================================
export function handleFastTokenClose(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const tokenModal = document.getElementById('tokenModalOverlay');
    if (tokenModal) {
        tokenModal.style.display = 'none';
    }
    if (window.history.state && window.history.state.popup === 'tokenModal') {
        window.history.back();
    }
}

export function updateTokenInputState() {
    const inputBox = document.getElementById('inputBoxWrapperToken');
    const tokenInput = document.getElementById('tokenInput');
    if (!inputBox || !tokenInput) return;
    inputBox.classList.remove('error-state', 'success-state');
    if (tokenInput.value.trim().length > 0) {
        inputBox.classList.add('filled-state');
    } else {
        inputBox.classList.remove('filled-state');
    }
}

// ==========================================
// INITIALIZE AUTHENTICATION & TOKEN LISTENERS
// ==========================================
export function initAuthSystem(onLoginSuccessCallback) {
    // 1. Password Visibility Toggle
    document.getElementById('toggleEye')?.addEventListener('click', () => {
        const passInput = document.getElementById('loginPassword'); 
        const toggleIcon = document.getElementById('toggleIcon');
        if (!passInput || !toggleIcon) return;

        if (passInput.type === 'password') { 
            passInput.type = 'text'; 
            toggleIcon.classList.remove('fa-eye-slash');
            toggleIcon.classList.add('fa-eye');
        } else { 
            passInput.type = 'password'; 
            toggleIcon.classList.remove('fa-eye');
            toggleIcon.classList.add('fa-eye-slash');
        }
    });

    // 2. Email & Password Form Submit
    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault(); 
        const email = document.getElementById('loginEmail')?.value; 
        const pass = document.getElementById('loginPassword')?.value;
        const btn = document.getElementById('loginBtn'); 
        const originalContent = btn?.innerHTML || "Login";
        if (btn) btn.innerHTML = `<span style="display:flex; align-items:center; gap:8px;"><i class="fas fa-spinner fa-spin"></i> Authenticating...</span>`;
        try { 
            const userCred = await signInWithEmailAndPassword(auth, email, pass); 
            await syncUserProfileToFirestore(userCred.user);
            e.target.reset(); 
            if (btn) btn.innerHTML = originalContent; 
            closeLoginOverlayLocal();
            showToast("Login Successfully", "success");
            if (onLoginSuccessCallback) onLoginSuccessCallback();
        } catch(err) { 
            if (btn) btn.innerHTML = originalContent; 
            showToast("Invalid credentials", "error");
        } 
    });

    // 3. Google Sign-In Popup
    document.getElementById('googleSignInBtn')?.addEventListener('click', async () => { 
        const btn = document.getElementById('googleSignInBtn');
        const originalContent = btn?.innerHTML || "Continue with Google";
        if (btn) btn.innerHTML = `<span style="display:flex; align-items:center; gap:8px;"><i class="fas fa-spinner fa-spin"></i> Connecting...</span>`;
        try { 
            const result = await signInWithPopup(auth, provider); 
            await syncUserProfileToFirestore(result.user);
            if (btn) btn.innerHTML = originalContent; 
            closeLoginOverlayLocal();
            showToast("Google Login Successfully", "success");
            if (onLoginSuccessCallback) onLoginSuccessCallback();
        } catch(err) { 
            if (btn) btn.innerHTML = originalContent; 
            showToast("Sign in failed", "error");
        } 
    });

    // 4. Forgot Password Flow
    document.getElementById('forgotPasswordBtn')?.addEventListener('click', async () => {
        const emailInput = document.getElementById('loginEmail');
        let targetEmail = emailInput ? emailInput.value.trim().toLowerCase() : "";

        if (!targetEmail || !targetEmail.includes('@')) {
            showToast("Enter registered email", "error");
            emailInput?.focus();
            return;
        }

        try {
            showToast("Verifying admin...", "success");
            const adminDocRef = doc(db, "admins", targetEmail);
            const adminDocSnap = await getDoc(adminDocRef);

            if (!adminDocSnap.exists()) {
                showToast("Admin access denied", "error");
                return;
            }

            await sendPasswordResetEmail(auth, targetEmail);
            showToast("Reset link sent!", "success");
        } catch (err) {
            showToast("Reset link failed", "error");
        }
    });

    // 5. Logout Overlay Buttons
    document.getElementById('closeLoginBtn')?.addEventListener('click', closeLoginOverlayLocal);
    document.getElementById('menu-logout-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLogoutDialog();
    });

    document.getElementById('cancelLogoutBtn')?.addEventListener('click', (e) => { 
        e.preventDefault();
        e.stopPropagation();
        closeLogoutDialog();
    });

    document.getElementById('customLogoutOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'customLogoutOverlay') {
            closeLogoutDialog();
        }
    });

    document.getElementById('confirmLogoutBtn')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const confirmBtn = document.getElementById('confirmLogoutBtn');
        if (confirmBtn) {
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            confirmBtn.style.pointerEvents = 'none';
        }
        try {
            await signOut(auth);
            localStorage.removeItem('isUserLoggedIn');
            window.location.reload();
        } catch (error) {
            if (confirmBtn) {
                confirmBtn.innerHTML = 'Yes, Log Out';
                confirmBtn.style.pointerEvents = 'auto';
            }
            showToast("Logout failed", "error");
        }
    });

    // 6. Access Token Modal Controls
    const tokenInput = document.getElementById('tokenInput');
    const tokenModal = document.getElementById('tokenModalOverlay');
    const inputBox = document.getElementById('inputBoxWrapperToken');
    const getKeyBtn = document.getElementById('getKeyBtn');
    const verifyBtn = document.getElementById('verifyBtn');
    const closeTokenBtn = document.getElementById('closeTokenModalBtn');

    tokenInput?.addEventListener('input', updateTokenInputState);

    tokenInput?.addEventListener('focus', () => {
        tokenModal?.classList.add('keyboard-active');
        inputBox?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    tokenInput?.addEventListener('blur', () => {
        tokenModal?.classList.remove('keyboard-active');
    });

    tokenInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            tokenInput.blur();
            verifyBtn?.click();
        }
    });

    if (closeTokenBtn) {
        closeTokenBtn.addEventListener('click', handleFastTokenClose);
        closeTokenBtn.addEventListener('touchstart', handleFastTokenClose, { passive: false });
    }

    // 7. Get Key Link Generation
    getKeyBtn?.addEventListener('click', async () => {
        const originalContent = getKeyBtn.innerHTML;
        getKeyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Securing Link...';
        getKeyBtn.style.pointerEvents = 'none';

        try {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let rawCode = 'SPIDY-';
            for (let i = 0; i < 16; i++) {
                rawCode += chars.charAt(Math.floor(Math.random() * chars.length));
            }

            const now = Date.now();
            const expiresAt = now + (10 * 24 * 60 * 60 * 1000);
            
            await setDoc(doc(db, "tokens", rawCode), {
                token: rawCode,
                used: false,
                createdAt: now,
                expiresAt: expiresAt,
                deviceBound: null,
                isActivated: true,
                source: 'shortlink_generated'
            });

            localStorage.setItem('spidy_pending_generated_key', rawCode);
            localStorage.setItem('spidy_pending_key_time', now.toString());

            const destinationUrl = `https://multiverse-books.vercel.app/api/generate?code=${encodeURIComponent(rawCode)}`;
            const finalRedirect = encodeURIComponent(destinationUrl);

            window.location.href = `https://arolinks.com/6RTf5?url=${finalRedirect}`;

        } catch (e) {
            window.location.href = "https://arolinks.com/6RTf5";
        } finally {
            setTimeout(() => {
                getKeyBtn.innerHTML = originalContent;
                getKeyBtn.style.pointerEvents = 'auto';
            }, 1500);
        }
    });

    // 8. Token Verification
    verifyBtn?.addEventListener('click', async () => {
        const tokenValue = tokenInput ? tokenInput.value.trim() : "";

        inputBox?.classList.remove('error-state', 'success-state', 'filled-state');
        
        if (tokenValue.length < 5) {
            inputBox?.classList.add('error-state');
            showToast('Invalid token format', 'error');
            setTimeout(() => {
                inputBox?.classList.remove('error-state');
                updateTokenInputState();
            }, 2000);
            return;
        }

        verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
        const currentFingerprint = generateDeviceFingerprint(auth.currentUser?.uid);

        try {
            const response = await fetch('/api/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: tokenValue, fingerprint: currentFingerprint })
            });
            const data = await response.json();

            if (response.ok && data.success) {
                inputBox?.classList.add('success-state');
                showToast('Access Granted! 10 Days.', 'success');
                
                localStorage.removeItem('spidy_pending_generated_key');
                localStorage.removeItem('spidy_pending_key_time');

                localStorage.setItem('spidy_secure_session', JSON.stringify({
                    token: tokenValue,
                    fp: currentFingerprint,
                    expiry: Date.now() + (10 * 24 * 60 * 60 * 1000)
                }));

                setTimeout(() => {
                    if (tokenModal) tokenModal.style.display = 'none';
                    verifyBtn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
                    if (document.getElementById("downloadModal")?.style.display === "flex") {
                        document.getElementById("dlReadOnlineBtn")?.click();
                    }
                }, 1000);
            } else {
                inputBox?.classList.add('error-state');
                showToast('Token expired or invalid', 'error');
                verifyBtn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
                setTimeout(() => {
                    inputBox?.classList.remove('error-state');
                    updateTokenInputState();
                }, 2000);
            }
        } catch (err) {
            inputBox?.classList.add('error-state');
            showToast('Verification failed', 'error');
            verifyBtn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify';
            setTimeout(() => {
                inputBox?.classList.remove('error-state');
                updateTokenInputState();
            }, 2000);
        }
    });
}
