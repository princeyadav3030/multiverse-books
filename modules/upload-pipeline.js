// File: modules/upload-pipeline.js

import { db, auth, collection, addDoc, doc, setDoc, serverTimestamp } from "./firebase-config.js";
import { showToast, generateCleanSlug, WORKER_PROXY_URL, DEFAULT_AVATAR } from "./helpers.js";

// ==========================================
// UPLOAD PIPELINE STATE & CONSTANTS
// ==========================================
export let selectedCoverFile = null;
export let selectedPdfFile = null;
export let detectedTotalPages = 0;
export let detectedFileSizeMB = "0 MB";

export function autoScrollToElement(el, container) {
    if (!el || !container) return;
    setTimeout(() => {
        const targetTop = el.offsetTop - 15;
        container.scrollTo({
            top: targetTop,
            behavior: 'smooth'
        });
    }, 180);
}

export function resetUploadFormState() {
    const form = document.getElementById('addBookForm');
    if (form) form.reset();

    const coverInput = document.getElementById('fileCoverSelect');
    const pdfInput = document.getElementById('filePdfSelect');
    if (coverInput) coverInput.value = "";
    if (pdfInput) pdfInput.value = "";

    selectedCoverFile = null;
    selectedPdfFile = null;
    detectedTotalPages = 0;
    detectedFileSizeMB = "0 MB";

    const coverStatus = document.getElementById('coverStatusText');
    if (coverStatus) {
        coverStatus.innerText = "Drag & Drop Cover Image";
        coverStatus.title = "Drag & Drop Cover Image";
        coverStatus.style.color = "";
    }

    const pdfStatus = document.getElementById('pdfStatusText');
    if (pdfStatus) {
        pdfStatus.innerText = "Drag & Drop PDF File";
        pdfStatus.title = "Drag & Drop PDF File";
        pdfStatus.style.color = "";
    }

    const liveCoverImg = document.getElementById('syncLiveCoverImg');
    const defaultCoverIcon = document.getElementById('syncDefaultCoverIcon');
    if (liveCoverImg) {
        liveCoverImg.src = "";
        liveCoverImg.style.display = 'none';
    }
    if (defaultCoverIcon) defaultCoverIcon.style.display = 'block';

    ['wrapTitle', 'wrapAuthor', 'wrapExams'].forEach(id => {
        document.getElementById(id)?.classList.remove('has-value');
    });
}

// ==========================================
// BULLETPROOF DIRECT R2 STREAM ENGINE
// ==========================================
export function uploadDirectStream(targetUrl, file, mimeType, onProgress, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        function attemptUpload() {
            attempts++;
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", targetUrl, true);
            xhr.setRequestHeader("Content-Type", mimeType || "application/octet-stream");
            
            // Mobile network timeouts drop hone se bachane ke liye timeout zero rakha hai
            xhr.timeout = 0; 

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(e.loaded, e.total);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve({ success: true });
                } else if (attempts < maxRetries) {
                    setTimeout(attemptUpload, 1500 * attempts);
                } else {
                    reject(new Error(`Storage rejected upload (HTTP ${xhr.status})`));
                }
            };

            xhr.onerror = () => {
                if (attempts < maxRetries) {
                    setTimeout(attemptUpload, 2000 * attempts);
                } else {
                    reject(new Error("Network connection dropped during upload. Please check your internet connection."));
                }
            };

            xhr.ontimeout = () => {
                if (attempts < maxRetries) {
                    setTimeout(attemptUpload, 1500 * attempts);
                } else {
                    reject(new Error("Upload connection timed out"));
                }
            };

            xhr.send(file);
        }

        attemptUpload();
    });
}

export async function uploadFileSmart(authData, file, mimeType, onProgress) {
    const directPresignedUrl = typeof authData === 'object' ? authData?.uploadUrl : null;
    const fileKey = typeof authData === 'string' ? authData : (authData?.fileKey || "");

    // 1. Direct High-Speed S3/R2 Stream (Bypasses worker body limit)
    if (directPresignedUrl) {
        return await uploadDirectStream(directPresignedUrl, file, mimeType, onProgress);
    }

    // 2. Fallback to worker proxy only if presigned url is absent
    let cleanKey = fileKey.replace(/^\/+/, "");
    const targetUrl = `${WORKER_PROXY_URL}/upload?key=${encodeURIComponent(cleanKey)}`;
    return await uploadDirectStream(targetUrl, file, mimeType, onProgress);
}

// ==========================================
// INITIALIZE UPLOAD PIPELINE
// ==========================================
export function initUploadPipeline(isSuperAdminCheck, onBookPublishedCallback) {
    const uploadContentArea = document.getElementById('admContentArea');

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
                document.getElementById('yearPopupOverlay')?.classList.remove('active');
            });
        });
    }
    buildDynamicYearList();

    const admTabAdd = document.getElementById('admTabAdd');
    const admTabPrompt = document.getElementById('admTabPrompt');
    const switchTrack = document.getElementById('switchTrack');
    const sectionAddBook = document.getElementById('sectionAddBook');
    const sectionPrompt = document.getElementById('sectionPrompt');

    admTabAdd?.addEventListener('click', (e) => {
        e.preventDefault();
        switchTrack?.classList.remove('show-prompt');
        admTabAdd.classList.add('active');
        admTabPrompt?.classList.remove('active');
        sectionAddBook?.classList.add('active');
        sectionPrompt?.classList.remove('active');
        if (uploadContentArea) uploadContentArea.scrollTop = 0;
    });

    admTabPrompt?.addEventListener('click', (e) => {
        e.preventDefault();
        switchTrack?.classList.add('show-prompt');
        admTabPrompt.classList.add('active');
        admTabAdd?.classList.remove('active');
        sectionPrompt?.classList.add('active');
        sectionAddBook?.classList.remove('active');
        if (uploadContentArea) uploadContentArea.scrollTop = 0;
    });

    const yearOverlay = document.getElementById('yearPopupOverlay');
    const langOverlay = document.getElementById('langPopupOverlay');

    document.getElementById('openYearModalBtn')?.addEventListener('click', () => yearOverlay?.classList.add('active'));
    document.getElementById('closeYearModalBtn')?.addEventListener('click', () => yearOverlay?.classList.remove('active'));
    yearOverlay?.addEventListener('click', (e) => {
        if (e.target === yearOverlay) yearOverlay.classList.remove('active');
    });

    document.getElementById('openLangModalBtn')?.addEventListener('click', () => langOverlay?.classList.add('active'));
    document.getElementById('closeLangModalBtn')?.addEventListener('click', () => langOverlay?.classList.remove('active'));
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

    document.getElementById('fileCoverSelect')?.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            selectedCoverFile = e.target.files[0];
            const coverStatus = document.getElementById('coverStatusText');
            coverStatus.innerText = "Selected: " + selectedCoverFile.name;
            coverStatus.title = "Selected: " + selectedCoverFile.name;
            coverStatus.style.color = '#ffffff';

            const pdfCard = document.getElementById('cardPdfContainer');
            autoScrollToElement(pdfCard, uploadContentArea);
        }
    });

    document.getElementById('filePdfSelect')?.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files.length > 0) {
            selectedPdfFile = e.target.files[0];
            const statusText = document.getElementById('pdfStatusText');

            const sizeInMB = (selectedPdfFile.size / (1024 * 1024)).toFixed(2);
            detectedFileSizeMB = `${sizeInMB} MB`;

            const isSuperAdmin = isSuperAdminCheck();
            const maxAllowed = isSuperAdmin ? (1024 * 1024 * 1024) : (250 * 1024 * 1024);
            if (selectedPdfFile.size > maxAllowed) {
                showToast(`File too large (Max ${isSuperAdmin ? '1GB' : '250MB'})`, "error");
                selectedPdfFile = null;
                statusText.innerText = "Drag & Drop PDF File";
                e.target.value = "";
                return;
            }

            if (selectedPdfFile.size > 50 * 1024 * 1024) {
                detectedTotalPages = 0;
                const fastLabel = `Selected: ${selectedPdfFile.name} (${detectedFileSizeMB})`;
                statusText.innerText = fastLabel;
                statusText.title = fastLabel;
                statusText.style.color = '#ffffff';
            } else {
                statusText.innerText = `Calculating Pages...`;
                try {
                    const arrayBuffer = await selectedPdfFile.arrayBuffer();
                    const docRef = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
                    detectedTotalPages = docRef.numPages;

                    const fullLabel = `Selected: ${selectedPdfFile.name} (${detectedTotalPages} Pages)`;
                    statusText.innerText = fullLabel;
                    statusText.title = fullLabel;
                    statusText.style.color = '#ffffff';
                } catch (err) {
                    detectedTotalPages = 0;
                    statusText.innerText = `Selected: ${selectedPdfFile.name}`;
                    statusText.style.color = '#ffffff';
                }
            }

            const publishBtn = document.getElementById('publishBtn');
            autoScrollToElement(publishBtn, uploadContentArea);
        }
    });

    document.getElementById('addBookForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!auth.currentUser) {
            showToast("Please login first to upload", "error");
            return;
        }
        if (!selectedCoverFile) return showToast("Select a cover image", "error");
        if (!selectedPdfFile) return showToast("Select book PDF", "error");

        const pipeline = document.getElementById('uploadPipelineOverlay');
        const percentDisplay = document.getElementById('syncPercentDisplay');
        const progressFill = document.getElementById('syncProgressFill');
        const transferredBytes = document.getElementById('syncTransferredBytes');
        const speedVal = document.getElementById('syncSpeedVal');
        const stageTitle = document.getElementById('syncStageTitle');
        const liveCoverImg = document.getElementById('syncLiveCoverImg');
        const defaultCoverIcon = document.getElementById('syncDefaultCoverIcon');

        const inputTitle = document.getElementById('inTitle')?.value.trim() || selectedPdfFile.name;
        document.getElementById('syncDynamicTitle').innerText = inputTitle;
        document.getElementById('syncDynamicPdfSize').innerText = `PDF Size: ${(selectedPdfFile.size / (1024 * 1024)).toFixed(2)} MB`;

        // Live cover preview during upload
        const reader = new FileReader();
        reader.onload = (evt) => {
            liveCoverImg.src = evt.target.result;
            liveCoverImg.style.display = 'block';
            defaultCoverIcon.style.display = 'none';
        };
        reader.readAsDataURL(selectedCoverFile);

        // Combined Single Progress Tracker Calculation
        const totalBytes = selectedCoverFile.size + selectedPdfFile.size;
        const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
        let coverLoaded = 0;
        let pdfLoaded = 0;
        let lastLoaded = 0;
        let lastTime = Date.now();

        pipeline.style.display = 'flex';
        stageTitle.innerText = "Connecting Secure Storage...";
        percentDisplay.innerHTML = `0<span class="percent-symbol">%</span>`;
        progressFill.style.width = `0%`;
        transferredBytes.innerText = `0.00 MB / ${totalMB} MB`;
        speedVal.innerText = "Connecting...";

        function updateTelemetry() {
            const loaded = coverLoaded + pdfLoaded;
            // 98% tak upload stream rahegi, baki 2% database registration ke liye reserve
            const percent = Math.min(98, Math.floor((loaded / totalBytes) * 98));
            percentDisplay.innerHTML = `${percent}<span class="percent-symbol">%</span>`;
            progressFill.style.width = `${percent}%`;
            transferredBytes.innerText = `${(loaded / (1024 * 1024)).toFixed(2)} MB / ${totalMB} MB`;

            const now = Date.now();
            const diff = (now - lastTime) / 1000;
            if (diff >= 0.25) {
                const rawSpeed = (((loaded - lastLoaded) / (1024 * 1024)) / diff).toFixed(1);
                if (rawSpeed > 0) {
                    speedVal.innerText = `${rawSpeed} MB/s`;
                }
                lastLoaded = loaded;
                lastTime = now;
            }
        }

        try {
            const userToken = await auth.currentUser.getIdToken(true);
            const coverMime = selectedCoverFile.type || "image/jpeg";
            const pdfMime = selectedPdfFile.type || "application/pdf";

            // Authorize both upload slots with backend
            const [coverAuthRes, pdfAuthRes] = await Promise.all([
                fetch('/api/generate-upload-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fileName: selectedCoverFile.name,
                        fileSize: selectedCoverFile.size,
                        fileType: 'image',
                        mimeType: coverMime,
                        userToken: userToken
                    })
                }),
                fetch('/api/generate-upload-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fileName: selectedPdfFile.name,
                        fileSize: selectedPdfFile.size,
                        fileType: 'pdf',
                        mimeType: pdfMime,
                        userToken: userToken
                    })
                })
            ]);

            const [coverAuthData, pdfAuthData] = await Promise.all([
                coverAuthRes.json(),
                pdfAuthRes.json()
            ]);

            if (!coverAuthRes.ok || !coverAuthData.success) {
                throw new Error(coverAuthData.error || "Cover permission denied");
            }
            if (!pdfAuthRes.ok || !pdfAuthData.success) {
                throw new Error(pdfAuthData.error || "PDF permission denied");
            }

            stageTitle.innerText = "Direct Fast Uploading...";

            // Sequential Upload Execution:
            // Mobile bandwidth drop se bachane ke liye pehle Cover (0.5s), turant baad PDF.
            // Dono ka byte progress single smooth bar me display hoga.
            await uploadFileSmart(coverAuthData, selectedCoverFile, coverMime, (loaded) => {
                coverLoaded = loaded;
                updateTelemetry();
            });

            await uploadFileSmart(pdfAuthData, selectedPdfFile, pdfMime, (loaded) => {
                pdfLoaded = loaded;
                updateTelemetry();
            });

            stageTitle.innerText = "Registering book & uploader profile...";
            percentDisplay.innerHTML = `99<span class="percent-symbol">%</span>`;
            progressFill.style.width = `99%`;

            const finalSlug = generateCleanSlug(inputTitle);
            const finalPagesCount = detectedTotalPages > 0 ? detectedTotalPages.toString() : "Complete Book";

            // Get current logged-in user profile details accurately
            const currentUser = auth.currentUser;
            const uploaderName = currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : "Verified Contributor");
            const uploaderEmail = currentUser.email || "";
            const uploaderPhoto = currentUser.photoURL || DEFAULT_AVATAR;

            // Database Object with complete uploader identification
            const newBook = {
                title: inputTitle,
                author: document.getElementById('inAuthor')?.value.trim() || "Unknown",
                year: document.getElementById('inYear')?.value.trim() || new Date().getFullYear().toString(),
                lang: document.getElementById('inLang')?.value.trim() || "Hindi",
                exams: document.getElementById('inExams')?.value.trim() || "General",
                slug: finalSlug,
                image: coverAuthData.fileKey,
                pdfLink: pdfAuthData.fileKey,
                fileSize: detectedFileSizeMB,
                sizeBytes: Number(selectedPdfFile.size),
                fileFormat: "PDF",
                totalPages: finalPagesCount,
                dateAdded: new Date().toLocaleDateString('en-GB').toUpperCase(),
                createdAt: serverTimestamp(),
                
                // Uploader Identity Fields (Firestore Rules Guarded)
                uploaderUid: currentUser.uid,
                uploaderName: uploaderName,
                uploaderEmail: uploaderEmail,
                uploaderPhoto: uploaderPhoto
            };

            // Save to Firestore books collection
            const docRef = await addDoc(collection(db, "books"), newBook);
            newBook.id = docRef.id;

            // Set user 24-hr upload cooldown timestamp in users collection
            if (!isSuperAdminCheck()) {
                await setDoc(doc(db, "users", currentUser.uid), {
                    lastBookUploadTime: Date.now(),
                    lastUploadedBookTitle: inputTitle
                }, { merge: true });
            }

            if (onBookPublishedCallback) onBookPublishedCallback(newBook);

            percentDisplay.innerHTML = `100<span class="percent-symbol">%</span>`;
            progressFill.style.width = `100%`;
            stageTitle.innerText = "Published Successfully! ✨";

            setTimeout(() => {
                pipeline.style.display = 'none';
                resetUploadFormState();
                showToast("Book Published Successfully!", "success");

                if (window.history.state && window.history.state.popup === 'uploadModal') {
                    window.history.back();
                } else {
                    document.getElementById('uploadModalOverlay')?.classList.remove('active');
                }
            }, 1200);

        } catch (error) {
            pipeline.style.display = 'none';
            showToast(error.message || "Upload failed. Please try again.", "error");
        }
    });
}
