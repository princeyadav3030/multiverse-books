const admin = require('firebase-admin');

// Firebase Admin Initialize (Sirf ek baar)
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
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { bookId, userToken, bookSlug } = req.body;
  if (!bookId || !userToken || !bookSlug) {
    return res.status(400).json({ error: 'Missing parameters: bookId, userToken, or bookSlug' });
  }

  let uid = null;
  let userEmail = "";

  // 1. Verify User Token
  try {
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    uid = decodedToken.uid;
    userEmail = (decodedToken.email || "").toLowerCase().trim();
  } catch (authErr) {
    console.error("Token verification failed:", authErr.message);
    return res.status(401).json({ error: 'Session Expired! Please re-login.' });
  }

  try {
    // 2. Super Admin Check
    let isSuperAdmin = false;
    if (userEmail) {
      const adminDoc = await db.collection('admins').doc(userEmail).get();
      isSuperAdmin = adminDoc.exists;
    }

    // 3. User Daily Unique 20 Limit Logic (Last 24 Hours)
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    
    let now = Date.now();
    let oneDayAgo = now - (24 * 60 * 60 * 1000);
    let validHistory = [];
    let uniqueAccessedSlugs = new Set();

    if (userSnap.exists) {
      let userData = userSnap.data();
      let rawDownloads = userData.recentDownloads || [];

      rawDownloads.forEach(item => {
        let itemTime = typeof item === 'number' ? item : item.time;
        let itemSlug = typeof item === 'number' ? null : item.slug;

        // Sirf pichhle 24 ghante ke records rakhna
        if (itemTime && (now - itemTime < 24 * 60 * 60 * 1000)) {
          validHistory.push({ slug: itemSlug, time: itemTime });
          if (itemSlug) uniqueAccessedSlugs.add(itemSlug);
        }
      });
    }

    const isAlreadyOpened = uniqueAccessedSlugs.has(bookSlug);

    // Agar nayi book hai aur already 20 unique books open ho chuki hain
    if (!isAlreadyOpened && !isSuperAdmin) {
      if (uniqueAccessedSlugs.size >= 20) {
        return res.status(403).json({ 
          success: false,
          error: 'Aapka 24 ghante ka limit (20 books) pura ho gaya hai! Aap wahi books open kar sakte hain jo aaj pehle open ki thi.' 
        });
      }

      // Nayi book ko record mein add karein
      validHistory.push({ slug: bookSlug, time: now });
      uniqueAccessedSlugs.add(bookSlug);

      // Database update (Sirf nayi book par lifetime count badhega)
      await userRef.set({
        recentDownloads: validHistory,
        lifetimeDownloads: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
    } else {
      // Purani book repeat open hui hai, array clean karke save karein
      await userRef.set({
        recentDownloads: validHistory
      }, { merge: true });
    }

    // 4. Book Data Fetch
    const bookDoc = await db.collection('books').doc(bookId).get();
    if (!bookDoc.exists) {
      return res.status(404).json({ error: 'Book not found in database!' });
    }

    const fileKey = bookDoc.data().pdfLink;
    if (!fileKey) {
      return res.status(404).json({ error: 'PDF file link missing for this book!' });
    }

    // 5. Cloudflare Worker Secure Stream URL
    const workerBaseUrl = (process.env.WORKER_URL || "https://spidy-proxy.spidybookhub-backend.workers.dev").replace(/\/+$/, "");
    const cleanKey = fileKey.replace(/^\/+/, '');
    const secureWorkerUrl = `${workerBaseUrl}/stream?file=${encodeURIComponent(cleanKey)}`;

    let remainingCredits = isSuperAdmin ? 9999 : Math.max(0, 20 - uniqueAccessedSlugs.size);

    return res.status(200).json({ 
      success: true, 
      pdfLink: secureWorkerUrl,
      remainingCredits: remainingCredits
    });

  } catch (error) {
    console.error("Backend Error:", error);
    return res.status(500).json({ error: 'Server Error: ' + (error.message || 'Verification Failed') });
  }
};
