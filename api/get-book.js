// File: api/get-book.js

const admin = require('firebase-admin');
const crypto = require('crypto');

// ==========================================
// 1. BULLETPROOF FIREBASE PRIVATE KEY PARSER
// ==========================================
function getCleanPrivateKey() {
  let key = process.env.FIREBASE_PRIVATE_KEY || "";
  if (!key) return undefined;
  
  key = key.trim().replace(/^["']|["']$/g, '');
  if (key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n');
  }
  return key;
}

// ==========================================
// 2. FIREBASE ADMIN INITIALIZE
// ==========================================
if (!admin.apps.length) {
  try {
    const formattedPrivateKey = getCleanPrivateKey();

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: formattedPrivateKey,
      }),
    });
  } catch (initErr) {
    console.error("Firebase Admin Init Error:", initErr.message);
  }
}

const db = admin.firestore();

// ==========================================
// 3. MAIN API HANDLER
// ==========================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });

  try {
    let bodyData = req.body;
    if (typeof bodyData === 'string') {
      try {
        bodyData = JSON.parse(bodyData);
      } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid JSON request payload' });
      }
    }

    let { bookId, userToken, bookSlug, pdfKey, docType } = bodyData || {};

    // 1. Validation Checks
    if (!userToken) {
      return res.status(400).json({ success: false, error: 'Missing parameter: userToken is required' });
    }

    if (!bookId && !pdfKey) {
      return res.status(400).json({ success: false, error: 'Missing parameters: Either bookId or pdfKey must be provided' });
    }

    // 2. Verify User Token
    let uid = null;
    let userEmail = "";
    try {
      const decodedToken = await admin.auth().verifyIdToken(userToken);
      uid = decodedToken.uid;
      userEmail = (decodedToken.email || "").toLowerCase().trim();
    } catch (authErr) {
      return res.status(401).json({ success: false, error: 'Session Expired! Please re-login.' });
    }

    // 3. Super Admin Check
    let isSuperAdmin = false;
    if (userEmail) {
      try {
        const adminDoc = await db.collection('admins').doc(userEmail).get();
        isSuperAdmin = adminDoc.exists;
      } catch (e) {
        console.warn("Admin check skipped:", e.message);
      }
    }

    // 4. Resolve File Key & Distinct Unique Tracking Key
    let fileKey = pdfKey;

    if (!fileKey && bookId) {
      const bookDoc = await db.collection('books').doc(bookId).get();
      if (!bookDoc.exists) {
        return res.status(404).json({ success: false, error: 'Book not found in database!' });
      }
      fileKey = bookDoc.data().pdfLink;
      if (!bookSlug) bookSlug = bookDoc.data().slug || bookId;
    }

    if (!fileKey || String(fileKey).trim() === "") {
      return res.status(404).json({ success: false, error: 'PDF file link missing!' });
    }

    // Sanitize Key Path (Purana domain ya full URL strip karna)
    let cleanKey = String(fileKey).trim();

    if (cleanKey.startsWith('http://') || cleanKey.startsWith('https://')) {
      try {
        const parsedUrl = new URL(cleanKey);
        cleanKey = parsedUrl.pathname.replace(/^\/+/, '');
        cleanKey = cleanKey.replace(/^stream\/?/, '').replace(/^upload\/?/, '');
      } catch (e) {
        cleanKey = cleanKey.replace(/^https?:\/\/[^/]+\/+/, '');
      }
    }

    cleanKey = cleanKey.replace(/^\/+/, '');

    // Isolate Folder Hierarchies strictly
    const isModule = docType === 'module' || cleanKey.includes('module_pdfs') || (!bookId && pdfKey);
    
    if (!cleanKey.includes('/')) {
      if (isModule) {
        cleanKey = `module_pdfs/${cleanKey}`;
      } else {
        cleanKey = `pdfs/${cleanKey}`;
      }
    }

    // Generate Guaranteed Unique Resource Key (prevents Module 1 & Module 2 collision)
    let uniqueTrackingKey = bookSlug;
    if (!uniqueTrackingKey || isModule) {
      const hash = crypto.createHash('md5').update(cleanKey).digest('hex').slice(0, 12);
      uniqueTrackingKey = isModule ? `module_${hash}` : (bookId || `book_${hash}`);
    }

    // 5. 24-Hours Unique Book Limit Logic
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    
    let now = Date.now();
    let validHistory = [];
    let uniqueAccessedSlugs = new Set();
    let currentLifetimeDownloads = 0;

    if (userSnap.exists) {
      let userData = userSnap.data();
      let rawDownloads = userData.recentDownloads || [];
      currentLifetimeDownloads = userData.lifetimeDownloads || 0;

      rawDownloads.forEach(item => {
        let itemTime = typeof item === 'number' ? item : item.time;
        let itemSlug = typeof item === 'number' ? null : item.slug;

        // 24 ghante ke andar ke reads retain karein
        if (itemTime && (now - itemTime < 24 * 60 * 60 * 1000)) {
          validHistory.push({ slug: itemSlug, time: itemTime });
          if (itemSlug) uniqueAccessedSlugs.add(itemSlug);
        }
      });
    }

    const isAlreadyOpened = uniqueAccessedSlugs.has(uniqueTrackingKey);

    // Limit Check (Admin bypass, 20 unique items daily)
    if (!isAlreadyOpened && !isSuperAdmin && uniqueAccessedSlugs.size >= 20) {
      return res.status(403).json({ 
        success: false,
        error: 'Daily reading limit reached (20 items). You can still re-read your already opened books/modules today!' 
      });
    }

    // Update DB (Nayi book open hone par count badhao, purani open par extra limit mat kaato)
    if (!isAlreadyOpened) {
      validHistory.push({ slug: uniqueTrackingKey, time: now });
      uniqueAccessedSlugs.add(uniqueTrackingKey);
      currentLifetimeDownloads += 1;

      await userRef.set({
        recentDownloads: validHistory,
        lifetimeDownloads: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
    } else {
      // Purane expired records clean rakhein bina count badhaye
      await userRef.set({
        recentDownloads: validHistory
      }, { merge: true });
    }

    // 6. Secure URL Generation (Updated to new active worker)
    const workerBaseUrl = (process.env.WORKER_URL || "https://spidy-proxy.spidybookhub.workers.dev").replace(/\/+$/, "");
    const secureWorkerUrl = `${workerBaseUrl}/${cleanKey}`;

    let remainingCredits = isSuperAdmin ? 9999 : Math.max(0, 20 - uniqueAccessedSlugs.size);

    return res.status(200).json({ 
      success: true, 
      pdfLink: secureWorkerUrl,
      trackingKey: uniqueTrackingKey,
      remainingCredits: remainingCredits,
      lifetimeDownloads: currentLifetimeDownloads,
      activeReadCount: validHistory.length
    });

  } catch (error) {
    console.error("Backend Error in get-book.js:", error);
    return res.status(500).json({ success: false, error: 'Server Error: ' + (error.message || 'Failed') });
  }
};
