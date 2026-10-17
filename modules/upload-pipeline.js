// File: modules/upload-pipeline.js

import { db, auth, collection, addDoc, doc, setDoc, serverTimestamp } from "./firebase-config.js";
import { showToast, generateCleanSlug, WORKER_PROXY_URL } from "./helpers.js";

// ==========================================
// UPLOAD PIPELINE STATE
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
// WORKER CLOUD STORAGE SMART UPLOAD ENGINE
// ==========================================
export function uploadSingleBlobViaWorker(targetUrl, blob, mimeType, onProgress, maxRetries = 4) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        function attemptUpload() {
            attempts++;
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", targetUrl, true);
            xhr.setRequestHeader("Content-Type", mimeType || "application/octet-stream");

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(e.loaded, e.total);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const parsed = JSON.parse(xhr.responseText);
                        resolve(parsed);
                    } catch(e) {
                        resolve({ success: true, etag: xhr.getResponseHeader("ETag") || `part-etag-${Date.now()}` });
                    }
                } else if (attempts < maxRetries) {
                    setTimeout(attemptUpload, 1200);
                } else {
                    reject(new Error(`Storage error (${xhr.status})`));
                }
            };

            xhr.onerror = () => {
                if (attempts < maxRetries) {
                    setTimeout(attemptUpload, 1500);
                } else {
                    reject(new Error("Network connection error"));
                }
            };

            xhr.ontimeout = () => {
                if (attempts < maxRetries) {
                    setTimeout(attemptUpload, 1500);
                } else {
                    reject(new Error("Connection timed out"));
                }
            };

            xhr.send(blob);
        }

        attemptUpload();
    });
}

export async function uploadFileSmart(fileKey, file, mimeType, onProgress) {
    let cleanKey = fileKey.replace(/^\/+/, "");
    if (cleanKey.startsWith("http://") || cleanKey.startsWith("https://")) {
        try {
            const u = new URL(cleanKey);
            cleanKey = u.pathname.replace(/^\/+/, "");
        } catch(e) {}
    }

    const fileSize = file.size;

    // Small files under 10MB direct single upload
    if (fileSize <= 10 * 1024 * 1024) {
        const targetUrl = `${WORKER_PROXY_URL}/upload?key=${encodeURIComponent(cleanKey)}`;
        return await uploadSingleBlobViaWorker(targetUrl, file, mimeType, (loaded, total) => {
            if (onProgress) onProgress(loaded, total);
        });
    }

    // Dynamic Chunk Sizing for Large Files
    let CHUNK_SIZE = 5 * 1024 * 1024; // Default 5 MB
    if (fileSize > 300 * 1024 * 1024) {
        CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB chunks for 300MB - 1GB+
    } else if (fileSize > 80 * 1024 * 1024) {
        CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB chunks for medium files
    }

    const createRes = await fetch(`${WORKER_PROXY_URL}/multipart/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cleanKey, contentType: mimeType || "application/pdf" })
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData.success) {
        throw new Error(createData.error || "Upload init failed");
    }

    const uploadId = createData.uploadId;
    const totalParts = Math.ceil(fileSize / CHUNK_SIZE);
    const uploadedParts = new Array(totalParts);
    
    // Concurrency setup: 3 chunks parallel stream
    const CONCURRENCY_LIMIT = 3;
    let currentPartIndex = 0;
    const partProgressTrack = new Array(totalParts).fill(0);

    function reportOverallProgress() {
        if (!onProgress) return;
        const totalUploadedSoFar = partProgressTrack.reduce((sum, val) => sum + val, 0);
        onProgress(Math.min(totalUploadedSoFar, fileSize), fileSize);
    }

    async function processNextPartWorker() {
        while (currentPartIndex < totalParts) {
            const partIdx = currentPartIndex++;
            const partNumber = partIdx + 1;
            const start = partIdx * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, fileSize);
            const chunkBlob = file.slice(start, end);
            const partSize = end - start;

            const partUrl = `${WORKER_PROXY_URL}/multipart/upload-part?key=${encodeURIComponent(cleanKey)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;

            const partResult = await uploadSingleBlobViaWorker(partUrl, chunkBlob, "application/octet-stream", (loaded) => {
                partProgressTrack[partIdx] = Math.min(loaded, partSize);
                reportOverallProgress();
            });

            if (!partResult || !partResult.etag) {
                throw new Error(`Part ${partNumber} write failed`);
            }

            partProgressTrack[partIdx] = partSize;
            reportOverallProgress();

            uploadedParts[partIdx] = {
                partNumber: partNumber,
                etag: partResult.etag
            };
        }
    }

    // Launch worker pool
    const activeWorkers = [];
    const poolSize = Math.min(CONCURRENCY_LIMIT, totalParts);
    for (let i = 0; i < poolSize; i++) {
        activeWorkers.push(processNextPartWorker());
    }

    await Promise.all(activeWorkers);

    // Finalize Complete Multipart
    const completeRes = await fetch(`${WORKER_PROXY_URL}/multipart/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            key: cleanKey,
            uploadId: uploadId,
            parts: uploadedParts
        })
    });
    const completeData = await completeRes.json();
    if (!completeRes.ok || !completeData.success) {
        throw new Error(completeData.error || "Upload finalize failed");
    }

    if (onProgress) onProgress(fileSize, fileSize);
    return true;
}

// ==========================================
// INITIALIZE UPLOAD PIPELINE
// ==========================================
export function initUploadPipeline(isSuperAdminCheck, onBookPublishedCallback) {
    const uploadContentArea = document.getElementById('admContentArea');

    // Input Icon Color Watcher
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

    // Dynamic Publish Year Picker
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

    // Tabs Switcher: Add Book vs Prompts
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

    // Language & Year Modal Overlay Triggers
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

    // Cover File Selector
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

    // PDF File Selector & Accurate Instant Page Counting
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

            statusText.innerText = `Calculating Pages...`;

            // Memory-Safe Blob URL for PDF.js without damaging file trailers
            let objectBlobUrl = null;
            try {
                objectBlobUrl = URL.createObjectURL(selectedPdfFile);
                const loadingTask = window.pdfjsLib.getDocument({
                    url: objectBlobUrl,
                    disableAutoFetch: true,
                    disableStream: false
                });

                const docRef = await loadingTask.promise;
                detectedTotalPages = docRef.numPages;

                const fullLabel = `Selected: ${selectedPdfFile.name} (${detectedTotalPages} Pages)`;
                statusText.innerText = fullLabel;
                statusText.title = fullLabel;
                statusText.style.color = '#ffffff';
            } catch(err) {
                // Secondary fallback: ArrayBuffer stream
                try {
                    const arrayBuffer = await selectedPdfFile.arrayBuffer();
                    const docRef = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                    detectedTotalPages = docRef.numPages;
                    const fullLabel = `Selected: ${selectedPdfFile.name} (${detectedTotalPages} Pages)`;
                    statusText.innerText = fullLabel;
                    statusText.title = fullLabel;
                    statusText.style.color = '#ffffff';
                } catch(e2) {
                    detectedTotalPages = 1;
                    statusText.innerText = `Selected: ${selectedPdfFile.name}`;
                    statusText.style.color = '#ffffff';
                }
            } finally {
                if (objectBlobUrl) {
                    URL.revokeObjectURL(objectBlobUrl);
                }
            }

            const publishBtn = document.getElementById('publishBtn');
            autoScrollToElement(publishBtn, uploadContentArea);
        }
    });

    // Form Submission & Live Upload Pipeline
    document.getElementById('addBookForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!auth.currentUser) {
            showToast("Please login first", "error");
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
        stageTitle.innerText = "Checking quota...";
        percentDisplay.innerHTML = `0<span class="percent-symbol">%</span>`;
        progressFill.style.width = `0%`;
        transferredBytes.innerText = `0.00 MB / ${totalMB} MB`;
        speedVal.innerText = "Connecting...";

        function updateTelemetry() {
            const loaded = coverLoaded + pdfLoaded;
            const percent = Math.min(98, Math.floor((loaded / totalBytes) * 98));
            percentDisplay.innerHTML = `${percent}<span class="percent-symbol">%</span>`;
            progressFill.style.width = `${percent}%`;
            transferredBytes.innerText = `${(loaded / (1024 * 1024)).toFixed(2)} MB / ${totalMB} MB`;

            const now = Date.now();
            const diff = (now - lastTime) / 1000;
            if (diff >= 0.25) {
                const rawSpeed = (((loaded - lastLoaded) / (1024 * 1024)) / diff).toFixed(1);
                speedVal.innerText = `${rawSpeed > 0 ? rawSpeed : "3.5"} MB/s`;
                lastLoaded = loaded;
                lastTime = now;
            }
        }

        try {
            const userToken = await auth.currentUser.getIdToken(true);

            const coverMime = selectedCoverFile.type || "image/jpeg";
            const pdfMime = selectedPdfFile.type || "application/pdf";

            const coverAuthRes = await fetch('/api/generate-upload-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileName: selectedCoverFile.name,
                    fileSize: selectedCoverFile.size,
                    fileType: 'image',
                    mimeType: coverMime,
                    userToken: userToken
                })
            });

            const coverAuthData = await coverAuthRes.json();
            if (!coverAuthRes.ok || !coverAuthData.success) {
                throw new Error(coverAuthData.error || "Permission denied");
            }

            const pdfAuthRes = await fetch('/api/generate-upload-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileName: selectedPdfFile.name,
                    fileSize: selectedPdfFile.size,
                    fileType: 'pdf',
                    mimeType: pdfMime,
                    userToken: userToken
                })
            });

            const pdfAuthData = await pdfAuthRes.json();
            if (!pdfAuthRes.ok || !pdfAuthData.success) {
                throw new Error(pdfAuthData.error || "Permission denied");
            }

            stageTitle.innerText = "Syncing Cover Artwork...";
            await uploadFileSmart(coverAuthData.fileKey, selectedCoverFile, coverMime, (loaded) => {
                coverLoaded = loaded;
                updateTelemetry();
            });

            stageTitle.innerText = "Fast Parallel Upload (Multi-Stream)...";
            await uploadFileSmart(pdfAuthData.fileKey, selectedPdfFile, pdfMime, (loaded) => {
                pdfLoaded = loaded;
                updateTelemetry();
            });

            stageTitle.innerText = "Registering book...";
            percentDisplay.innerHTML = `99<span class="percent-symbol">%</span>`;
            progressFill.style.width = `99%`;

            let baseSlug = generateCleanSlug(inputTitle);
            let finalSlug = baseSlug;

            const finalPagesCount = detectedTotalPages > 0 ? detectedTotalPages.toString() : "1";

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
                uploaderUid: auth.currentUser.uid
            };

            const docRef = await addDoc(collection(db, "books"), newBook);
            newBook.id = docRef.id;

            if (!isSuperAdminCheck()) {
                await setDoc(doc(db, "users", auth.currentUser.uid), {
                    lastBookUploadTime: Date.now()
                }, { merge: true });
            }

            if (onBookPublishedCallback) onBookPublishedCallback(newBook);

            percentDisplay.innerHTML = `100<span class="percent-symbol">%</span>`;
            progressFill.style.width = `100%`;
            stageTitle.innerText = "Published Successfully! ✨";

            setTimeout(() => {
                pipeline.style.display = 'none';
                resetUploadFormState();
                showToast("Book Published!", "success");

                if (window.history.state && window.history.state.popup === 'uploadModal') {
                    window.history.back();
                } else {
                    document.getElementById('uploadModalOverlay')?.classList.remove('active');
                }
            }, 1200);

        } catch (error) {
            pipeline.style.display = 'none';
            showToast("Upload failed", "error");
        }
    });
}
