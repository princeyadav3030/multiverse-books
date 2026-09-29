const admin = require('firebase-admin');
const crypto = require('crypto');

// ==========================================
// 1. FIREBASE ADMIN INITIALIZATION
// ==========================================
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
  } catch (err) {
    console.error("Firebase Admin Init Error:", err);
  }
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
  // CORS & Preflight Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { fileName, fileSize, userToken, fileType } = req.body;

  if (!userToken) {
    return res.status(401).json({ error: 'Authentication required. Please log in first.' });
  }

  try {
    // 2. User Authentication Check
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    const uid = decodedToken.uid;
    const userEmail = (decodedToken.email || "").toLowerCase().trim();

    // 3. Admin Status Check
    let isAdmin = false;
    if (userEmail) {
      const adminDoc = await db.collection('admins').doc(userEmail).get();
      isAdmin = adminDoc.exists;
    }

    // 4. Strict Anti-Bypass Check (Normal Users: 1 Book Per 24 Hours)
    if (!isAdmin) {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        const userData = userDoc.data();
        const lastUploadTime = userData.lastBookUploadTime || 0;
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const timeElapsed = Date.now() - lastUploadTime;

        if (timeElapsed < ONE_DAY_MS) {
          const remainingHours = Math.ceil((ONE_DAY_MS - timeElapsed) / (1000 * 60 * 60));
          return res.status(403).json({
            error: `Daily upload limit reached. Normal accounts can only publish 1 book per 24 hours. Please wait ${remainingHours} hour(s) before trying again.`
          });
        }
      }
    }

    // 5. File Size Limit Validation
    const MAX_USER_SIZE = 250 * 1024 * 1024;   // 250 MB
    const MAX_ADMIN_SIZE = 1024 * 1024 * 1024; // 1 GB
    const allowedLimit = isAdmin ? MAX_ADMIN_SIZE : MAX_USER_SIZE;

    const numericFileSize = Number(fileSize);
    if (numericFileSize && numericFileSize > allowedLimit) {
      const limitText = isAdmin ? "1 GB" : "250 MB";
      return res.status(403).json({ 
        error: `File size exceeds the allowed limit. Maximum allowed: ${limitText}.` 
      });
    }

    // 6. Safe Key Format (Bucket ke covers/ aur pdfs/ folder me jayega)
    const folderPrefix = fileType === 'image' ? 'covers' : 'pdfs';
    const cleanExt = (fileName || "").split('.').pop().toLowerCase() || (fileType === 'image' ? 'jpg' : 'pdf');
    const randomHex = crypto.randomBytes(6).toString('hex');
    const cleanBaseName = (fileName || "file")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 15);

    // Collision-Proof Unique Key
    const safeKey = `${folderPrefix}/${Date.now()}_${uid.slice(0, 5)}_${randomHex}_${cleanBaseName}.${cleanExt}`;

    // Authorized Ticket Return
    return res.status(200).json({ 
      success: true,
      fileKey: safeKey,
      isAdmin: isAdmin
    });

  } catch (error) {
    console.error("Upload Authorization Error:", error);
    return res.status(500).json({ 
      error: error.message || 'Failed to authorize upload. Please try again.' 
    });
  }
};
