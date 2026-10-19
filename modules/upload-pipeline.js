// File: modules/upload-pipeline.js

import { db, auth, collection, addDoc, doc, setDoc, serverTimestamp } from "./firebase-config.js";
import { showToast, generateCleanSlug, WORKER_PROXY_URL, DEFAULT_AVATAR } from "./helpers.js";

// ==========================================
// 1. UPLOAD PIPELINE STATE & CONSTANTS
// ==========================================
export let selectedCoverFile = null;
export let selectedPdfFile = null;
export let detectedTotalPages = 0;
export let detectedFileSizeMB = "0 MB";
let cachedCoverDataUrl = null; // Memory-safe Base64 cache for Cover Preview

// 8 MB Chunk Size (Cloudflare Worker limit aur Mobile Network ke liye sabse best aur fast)
const CHUNK_SIZE = 8 * 1024 * 1024; 

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

// FIXED: Memory & CSP Safe Base64 Cover Preview (Kabhi Broken Icon Nahi Aayega)
export function updateLiveCoverPreviewUI(file) {
    const liveCoverImg = document.getElementById('syncLiveCoverImg');
    const defaultCoverIcon = document.getElementById('syncDefaultCoverIcon');
    if (!liveCoverImg) return;

    // Reset state if no file is passed
    if (!file) {
        cachedCoverDataUrl = null;
        liveCoverImg.removeAttribute('src');
        liveCoverImg.style.display = 'none';
        if (defaultCoverIcon) defaultCoverIcon.style.display = 'block';
        return;
    }

    // Fallback handler if image ever fails to decode
    liveCoverImg.onerror = () => {
        liveCoverImg.style.display = 'none';
        if (defaultCoverIcon) defaultCoverIcon.style.display = 'block';
    };

    liveCoverImg.onload = () => {
        liveCoverImg.style.display = 'block';
        liveCoverImg.style.width = '100%';
        liveCoverImg.style.height = '100%';
        liveCoverImg.style.objectFit = 'cover';
        liveCoverImg.style.borderRadius = '8px';
        if (defaultCoverIcon) defaultCoverIcon.style.display = 'none';
    };

    // If we already converted this exact file, reuse cached Base64 immediately
    if (cachedCoverDataUrl && file._cachedBase64) {
        liveCoverImg.src = file._cachedBase64;
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const resultDataUrl = e.target?.result;
        if (resultDataUrl) {
            cachedCoverDataUrl = resultDataUrl;
            file._cachedBase64 = resultDataUrl;
            liveCoverImg.src = resultDataUrl;
        }
    };
    reader.onerror = () => {
        // Fallback to ObjectURL only if FileReader fails
        try {
            const objUrl = URL.createObjectURL(file);
            liveCoverImg.src = objUrl;
        } catch (err) {
            liveCoverImg.style.display = 'none';
            if (defaultCoverIcon) defaultCoverIcon.style.display = 'block';
        }
    };
    reader.readAsDataURL(file);
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
    cachedCoverDataUrl = null;

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

    updateLiveCoverPreviewUI(null);

    ['wrapTitle', 'wrapAuthor', 'wrapExams'].forEach(id => {
        document.getElementById(id)?.classList.remove('has-value');
    });
}

// ==========================================
// 2. ZERO-FAILURE CHUNKED & STREAM UPLOAD ENGINE
// ==========================================

// Single binary chunk ya small file bhejne ka bulletproof XHR helper (with retries & real error capture)
export function sendBinaryXHR(targetUrl, blobOrFile, mimeType, onChunkProgress, maxRetries = 4) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        function attemptSend() {
            attempts++;
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", targetUrl, true);
            
            // Safe Content-Type header to avoid strict CORS preflight rejection
            if (mimeType) {
                xhr.setRequestHeader("Content-Type", mimeType);
            }
            xhr.timeout = 0; // Prevent mobile network timeout drops

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onChunkProgress) {
                    onChunkProgress(e.loaded);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    let parsed = {};
                    try {
                        parsed = JSON.parse(xhr.responseText || "{}");
                    } catch (e) {}
                    const headerEtag = xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag");
                    if (headerEtag && !parsed.etag) {
                        parsed.etag = headerEtag.replace(/^["']|["']$/g, '');
                    }
                    resolve(parsed);
                } else {
                    let errMessage = `Upload HTTP ${xhr.status}`;
                    try {
                        const errJson = JSON.parse(xhr.responseText || "{}");
                        if (errJson.error) errMessage = errJson.error;
                    } catch (e) {}

                    if (attempts < maxRetries && xhr.status !== 400 && xhr.status !== 403 && xhr.status !== 405) {
                        setTimeout(attemptSend, 1500 * attempts);
                    } else {
                        reject(new Error(errMessage));
                    }
                }
            };

            xhr.onerror = () => {
                if (attempts < maxRetries) {
                    setTimeout(attemptSend, 1800 * attempts);
                } else {
                    reject(new Error("Worker Upload Connection Blocked (CORS / Worker Not Deployed)"));
                }
            };

            xhr.ontimeout = () => {
                if (attempts < maxRetries) {
                    setTimeout(attemptSend, 1500 * attempts);
                } else {
                    reject(new Error("Upload timed out. Please retry."));
                }
            };

            xhr.send(blobOrFile);
        }

        attemptSend();
    });
}

// Multipart Chunked Engine (Uses spidy-proxy worker /multipart/* routes)
export async function uploadMultipartViaWorker(cleanKey, file, mimeType, onProgress) {
    const baseUrl = WORKER_PROXY_URL.replace(/\/+$/, "");

    // Step A: Create Multipart Upload Session on R2 via Worker
    let createRes;
    try {
        createRes = await fetch(`${baseUrl}/multipart/create`, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=UTF-8" }, // Bypasses strict CORS preflight
            body: JSON.stringify({
                key: cleanKey,
                contentType: mimeType || "application/pdf"
            })
        });
    } catch (netErr) {
        throw new Error("Cannot connect to Cloudflare Worker (/multipart/create). Please deploy updated worker.js!");
    }

    let createData = {};
    try {
        createData = await createRes.json();
    } catch (e) {
        throw new Error(`Worker returned status ${createRes.status} on /multipart/create. Please deploy updated worker.js!`);
    }

    if (!createRes.ok || !createData.uploadId) {
        throw new Error(createData.error || "Failed to initialize chunked upload session");
    }

    const uploadId = createData.uploadId;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadedParts = [];
    let totalConfirmedBytes = 0;

    // Step B: Upload 8MB Chunks Sequentially with Instant Progress & Auto-Retry
    for (let partIndex = 0; partIndex < totalChunks; partIndex++) {
        const partNumber = partIndex + 1;
        const startByte = partIndex * CHUNK_SIZE;
        const endByte = Math.min(startByte + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(startByte, endByte);

        const partUrl = `${baseUrl}/multipart/upload-part?key=${encodeURIComponent(cleanKey)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;

        const partResult = await sendBinaryXHR(
            partUrl,
            chunkBlob,
            "application/octet-stream",
            (chunkLoadedBytes) => {
                if (onProgress) {
                    onProgress(totalConfirmedBytes + chunkLoadedBytes, file.size);
                }
            },
            5 // 5 retries per 8MB chunk
        );

        if (!partResult || !partResult.etag) {
            throw new Error(`Missing ETag for chunk ${partNumber}`);
        }

        totalConfirmedBytes += chunkBlob.size;
        if (onProgress) {
            onProgress(totalConfirmedBytes, file.size);
        }

        uploadedParts.push({
            partNumber: partNumber,
            etag: partResult.etag
        });
    }

    // Step C: Complete Multipart Upload & Merge Chunks in R2
    const completeRes = await fetch(`${baseUrl}/multipart/complete`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" }, // Bypasses strict CORS preflight
        body: JSON.stringify({
            key: cleanKey,
            uploadId: uploadId,
            parts: uploadedParts
        })
    });

    const completeData = await completeRes.json();
    if (!completeRes.ok || !completeData.success) {
        throw new Error(completeData.error || "Failed to finalize multipart book file");
    }

    return { success: true, key: cleanKey };
}

// Smart Router: Small files (< 8MB) direct worker stream + Multipart fallback, Large files (>= 8MB) Chunked Multipart
export async function uploadFileSmart(authData, file, mimeType, onProgress) {
    const fileKey = typeof authData === 'string' ? authData : (authData?.fileKey || "");
    const directPresignedUrl = typeof authData === 'object' ? authData?.uploadUrl : null;
    const cleanKey = fileKey.replace(/^\/+/, "");
    const baseUrl = WORKER_PROXY_URL.replace(/\/+$/, "");

    // 1. Agar file 8 MB ya usse badi hai (jaise 215MB PDF), toh hamesha Chunked Multipart engine chalao
    if (file.size >= CHUNK_SIZE) {
        return await uploadMultipartViaWorker(cleanKey, file, mimeType, onProgress);
    }

    // 2. Chhoti files (Cover Image ya small PDF < 8MB) ke liye:
    // Attempt A: Direct Worker PUT (/upload)
    const workerUploadUrl = `${baseUrl}/upload?key=${encodeURIComponent(cleanKey)}`;
    try {
        await sendBinaryXHR(workerUploadUrl, file, mimeType || "application/octet-stream", (loaded) => {
            if (onProgress) onProgress(loaded, file.size);
        }, 2);
        return { success: true, key: cleanKey };
    } catch (workerPutErr) {
        console.warn("Direct /upload failed, trying Multipart via Worker...", workerPutErr.message);
        
        // Attempt B: Multipart via Worker (100% immune to single-stream PUT issues)
        try {
            return await uploadMultipartViaWorker(cleanKey, file, mimeType, onProgress);
        } catch (multipartErr) {
            console.warn("Multipart fallback failed, trying Presigned R2 URL...", multipartErr.message);

            // Attempt C: Direct R2 Presigned URL (if R2 bucket has CORS enabled)
            if (directPresignedUrl) {
                await sendBinaryXHR(directPresignedUrl, file, mimeType, (loaded) => {
                    if (onProgress) onProgress(loaded, file.size);
                }, 2);
                return { success: true, key: cleanKey };
            }
            throw multipartErr;
        }
    }
}

// ==========================================
// 3. INITIALIZE UPLOAD PIPELINE & UI LISTENERS
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

    // Cover File Selection & Instant Base64 Preview Binding
    document.getElementById('fileCoverSelect')?.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            selectedCoverFile = e.target.files[0];
            cachedCoverDataUrl = null; // Clear old cache for new file
            const coverStatus = document.getElementById('coverStatusText');
            if (coverStatus) {
                coverStatus.innerText = "Selected: " + selectedCoverFile.name;
                coverStatus.title = "Selected: " + selectedCoverFile.name;
                coverStatus.style.color = '#ffffff';
            }

            // Immediately convert & bind cover preview into memory
            updateLiveCoverPreviewUI(selectedCoverFile);

            const pdfCard = document.getElementById('cardPdfContainer');
            autoScrollToElement(pdfCard, uploadContentArea);
        }
    });

    // PDF File Selection & Size Guard (Admin: 1GB, Normal User: 250MB)
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
                if (statusText) statusText.innerText = "Drag & Drop PDF File";
                e.target.value = "";
                return;
            }

            if (selectedPdfFile.size > 50 * 1024 * 1024) {
                detectedTotalPages = 0;
                const fastLabel = `Selected: ${selectedPdfFile.name} (${detectedFileSizeMB})`;
                if (statusText) {
                    statusText.innerText = fastLabel;
                    statusText.title = fastLabel;
                    statusText.style.color = '#ffffff';
                }
            } else {
                if (statusText) statusText.innerText = `Calculating Pages...`;
                try {
                    const arrayBuffer = await selectedPdfFile.arrayBuffer();
                    const docRef = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
                    detectedTotalPages = docRef.numPages;

                    const fullLabel = `Selected: ${selectedPdfFile.name} (${detectedTotalPages} Pages)`;
                    if (statusText) {
                        statusText.innerText = fullLabel;
                        statusText.title = fullLabel;
                        statusText.style.color = '#ffffff';
                    }
                } catch (err) {
                    detectedTotalPages = 0;
                    if (statusText) {
                        statusText.innerText = `Selected: ${selectedPdfFile.name}`;
                        statusText.style.color = '#ffffff';
                    }
                }
            }

            const publishBtn = document.getElementById('publishBtn');
            autoScrollToElement(publishBtn, uploadContentArea);
        }
    });

    // Main Form Submit: Unified Progress & Chunked Upload
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

        const inputTitle = document.getElementById('inTitle')?.value.trim() || selectedPdfFile.name;
        const titleEl = document.getElementById('syncDynamicTitle');
        const sizeEl = document.getElementById('syncDynamicPdfSize');
        if (titleEl) titleEl.innerText = inputTitle;
        if (sizeEl) sizeEl.innerText = `PDF Size: ${(selectedPdfFile.size / (1024 * 1024)).toFixed(2)} MB`;

        // Ensure Cover Preview Image is visible inside the upload modal card
        updateLiveCoverPreviewUI(selectedCoverFile);

        // Unified Combined Byte Counter (Cover + PDF)
        const totalBytes = selectedCoverFile.size + selectedPdfFile.size;
        const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
        let coverLoaded = 0;
        let pdfLoaded = 0;
        let lastLoaded = 0;
        let lastTime = Date.now();
        let smoothedSpeed = 0;

        if (pipeline) pipeline.style.display = 'flex';
        if (stageTitle) stageTitle.innerText = "Verifying Upload Permissions...";
        if (percentDisplay) percentDisplay.innerHTML = `0<span class="percent-symbol">%</span>`;
        if (progressFill) progressFill.style.width = `0%`;
        if (transferredBytes) transferredBytes.innerText = `0.00 MB / ${totalMB} MB`;
        if (speedVal) speedVal.innerText = "Connecting...";

        function updateTelemetry() {
            const loaded = Math.min(totalBytes, coverLoaded + pdfLoaded);
            const percent = Math.min(98, Math.floor((loaded / totalBytes) * 98));
            
            if (percentDisplay) percentDisplay.innerHTML = `${percent}<span class="percent-symbol">%</span>`;
            if (progressFill) progressFill.style.width = `${percent}%`;
            if (transferredBytes) transferredBytes.innerText = `${(loaded / (1024 * 1024)).toFixed(2)} MB / ${totalMB} MB`;

            const now = Date.now();
            const diff = (now - lastTime) / 1000;
            if (diff >= 0.3) {
                const instantSpeed = ((loaded - lastLoaded) / (1024 * 1024)) / diff;
                if (instantSpeed > 0) {
                    smoothedSpeed = smoothedSpeed === 0 ? instantSpeed : (smoothedSpeed * 0.6 + instantSpeed * 0.4);
                    if (speedVal) speedVal.innerText = `${smoothedSpeed.toFixed(1)} MB/s`;
                }
                lastLoaded = loaded;
                lastTime = now;
            }
        }

        try {
            const userToken = await auth.currentUser.getIdToken(true);
            const coverMime = selectedCoverFile.type || "image/jpeg";
            const pdfMime = selectedPdfFile.type || "application/pdf";

            // 1. Verify User Quota & Get Safe Keys from Backend
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
                throw new Error(coverAuthData.error || "Cover upload permission denied");
            }
            if (!pdfAuthRes.ok || !pdfAuthData.success) {
                throw new Error(pdfAuthData.error || "PDF upload permission denied");
            }

            // 2. Upload Cover Image First (Seamless part of 0-100% bar)
            if (stageTitle) stageTitle.innerText = "Uploading Book Assets...";
            await uploadFileSmart(coverAuthData, selectedCoverFile, coverMime, (loaded) => {
                coverLoaded = loaded;
                updateTelemetry();
            });
            coverLoaded = selectedCoverFile.size;
            updateTelemetry();

            // 3. Upload PDF (Automatically uses 8MB Multipart Chunks for large PDFs)
            if (stageTitle) {
                stageTitle.innerText = selectedPdfFile.size >= CHUNK_SIZE 
                    ? "High-Speed Chunked Uploading..." 
                    : "Direct Fast Uploading...";
            }
            await uploadFileSmart(pdfAuthData, selectedPdfFile, pdfMime, (loaded) => {
                pdfLoaded = loaded;
                updateTelemetry();
            });
            pdfLoaded = selectedPdfFile.size;
            updateTelemetry();

            // 4. Register Book & Uploader Profile in Firestore
            if (stageTitle) stageTitle.innerText = "Finalizing & Publishing Book...";
            if (percentDisplay) percentDisplay.innerHTML = `99<span class="percent-symbol">%</span>`;
            if (progressFill) progressFill.style.width = `99%`;

            const finalSlug = generateCleanSlug(inputTitle);
            const finalPagesCount = detectedTotalPages > 0 ? detectedTotalPages.toString() : "Complete Book";

            const currentUser = auth.currentUser;
            const uploaderName = currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : "Verified Contributor");
            const uploaderEmail = currentUser.email || "";
            const uploaderPhoto = currentUser.photoURL || DEFAULT_AVATAR;

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
                
                // Complete Uploader Identity
                uploaderUid: currentUser.uid,
                uploaderName: uploaderName,
                uploaderEmail: uploaderEmail,
                uploaderPhoto: uploaderPhoto
            };

            const docRef = await addDoc(collection(db, "books"), newBook);
            newBook.id = docRef.id;

            // Update 24-Hr Cooldown Timestamp for Normal Users
            if (!isSuperAdminCheck()) {
                await setDoc(doc(db, "users", currentUser.uid), {
                    lastBookUploadTime: Date.now(),
                    lastUploadedBookTitle: inputTitle
                }, { merge: true });
            }

            if (onBookPublishedCallback) onBookPublishedCallback(newBook);

            if (percentDisplay) percentDisplay.innerHTML = `100<span class="percent-symbol">%</span>`;
            if (progressFill) progressFill.style.width = `100%`;
            if (stageTitle) stageTitle.innerText = "Published Successfully! ✨";

            setTimeout(() => {
                if (pipeline) pipeline.style.display = 'none';
                resetUploadFormState();
                showToast("Book Published Successfully!", "success");

                if (window.history.state && window.history.state.popup === 'uploadModal') {
                    window.history.back();
                } else {
                    document.getElementById('uploadModalOverlay')?.classList.remove('active');
                }
            }, 1200);

        } catch (error) {
            if (pipeline) pipeline.style.display = 'none';
            showToast(error.message || "Upload failed. Please try again.", "error");
        }
    });
}
