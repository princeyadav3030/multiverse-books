const admin = require('firebase-admin');

// Firebase Admin Initialize
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY 
          ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
          : undefined,
      }),
    });
  } catch (initErr) {
    console.error("Firebase Admin Init Error:", initErr);
  }
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let { bookId, userToken, bookSlug, pdfKey } = req.body;

  // Authentication token zaroori hai
  if (!userToken) {
    return res.status(400).json({ error: 'Missing parameters: userToken is required' });
  }

  // Normal book ya Module me se koi ek identifier hona chahiye
  if (!bookId && !pdfKey) {
    return res.status(400).json({ error: 'Missing parameters: Either bookId or pdfKey must be provided' });
  }

  // Slug fallback logic
  if (!bookSlug || String(bookSlug).trim() === "") {
    bookSlug = bookId || (pdfKey ? pdfKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-25) : "module-doc");
  }

  let uid = null;
  let userEmail = "";

  // 1. Verify User Token
  try {
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    uid = decodedToken.uid;
    userEmail = (decodedToken.email || "").toLowerCase().trim();
  } catch (authErr) {
    return res.status(401).json({ error: 'Session Expired! Please re-login.' });
  }

  try {
    // 2. Super Admin Check
    let isSuperAdmin = false;
    if (userEmail) {
      const adminDoc = await db.collection('admins').doc(userEmail).get();
      isSuperAdmin = adminDoc.exists;
    }

    // 3. User History & 24 Hours Retention Calculation
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

        // Exactly last 24 hours retention check
        if (itemTime && (now - itemTime < 24 * 60 * 60 * 1000)) {
          validHistory.push({ slug: itemSlug, time: itemTime });
          if (itemSlug) uniqueAccessedSlugs.add(itemSlug);
        }
      });
    }

    const isAlreadyOpened = uniqueAccessedSlugs.has(bookSlug);

    // 20 unique books daily limit check (Regular users only)
    if (!isAlreadyOpened && !isSuperAdmin && uniqueAccessedSlugs.size >= 20) {
      return res.status(403).json({ 
        success: false,
        error: 'Aapka 24 ghante ka limit pura ho gaya hai!' 
      });
    }

    // Agar nayi unique book kholi gayi hai toh add karo aur DB me update karo
    if (!isAlreadyOpened) {
      validHistory.push({ slug: bookSlug, time: now });
      uniqueAccessedSlugs.add(bookSlug);
      currentLifetimeDownloads += 1;

      await userRef.set({
        recentDownloads: validHistory,
        lifetimeDownloads: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
    } else {
      // Expired items ko database se clean karne ke liye update
      await userRef.set({
        recentDownloads: validHistory
      }, { merge: true });
    }

    // 4. Resolve File Key (Normal Book vs Module Pack)
    let fileKey = pdfKey;

    // Agar request normal book ki hai aur direct pdfKey nahi mili, toh database se fetch karo
    if (!fileKey && bookId) {
      const bookDoc = await db.collection('books').doc(bookId).get();
      if (!bookDoc.exists) {
        return res.status(404).json({ error: 'Book not found in database!' });
      }
      fileKey = bookDoc.data().pdfLink;
    }

    if (!fileKey) {
      return res.status(404).json({ error: 'PDF file link missing!' });
    }

    // 5. Proxy URL Generation
    const cleanKey = String(fileKey).replace(/^\/+/, '');
    const workerBaseUrl = (process.env.WORKER_URL || "https://spidy-proxy.spidybookhub-backend.workers.dev").replace(/\/+$/, "");
    
    // Proxy URL format
    const secureWorkerUrl = `${workerBaseUrl}/${cleanKey}`;

    let remainingCredits = isSuperAdmin ? 9999 : Math.max(0, 20 - uniqueAccessedSlugs.size);

    return res.status(200).json({ 
      success: true, 
      pdfLink: secureWorkerUrl,
      remainingCredits: remainingCredits,
      lifetimeDownloads: currentLifetimeDownloads,
      activeReadCount: validHistory.length
    });

  } catch (error) {
    console.error("Backend Error:", error);
    return res.status(500).json({ error: 'Server Error: ' + (error.message || 'Failed') });
  }
};
