const admin = require('firebase-admin');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

// ==========================================
// 1. BULLETPROOF FIREBASE PRIVATE KEY PARSER
// ==========================================
function getCleanPrivateKey() {
  let key = process.env.FIREBASE_PRIVATE_KEY || "";
  if (!key) return undefined;
  
  // Shuru aur aakhiri ke double/single quotes hatayein
  key = key.trim().replace(/^["']|["']$/g, '');
  
  // Literal '\n' characters ko real line breaks me badlein
  if (key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n');
  }
  return key;
}

// ==========================================
// 2. FIREBASE ADMIN INITIALIZATION
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
  } catch (err) {
    console.error("Firebase Admin Init Error:", err.message);
  }
}

const db = admin.firestore();

// ==========================================
// 3. CLOUDFLARE R2 S3 CLIENT
// ==========================================
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

// ==========================================
// 4. MAIN API HANDLER
// ==========================================
module.exports = async function handler(req, res) {
  // CORS Headers (Har response me milenge taaki browser block na kare)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    // Body parsing safe check
    let bodyData = req.body;
    if (typeof bodyData === 'string') {
      try {
        bodyData = JSON.parse(bodyData);
      } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid JSON request payload' });
      }
    }

    const { fileName, fileSize, userToken, fileType } = bodyData || {};

    if (!userToken) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please login.' });
    }

    // 5. User Token Verification
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(userToken);
    } catch (authErr) {
      console.error("Token verification failed:", authErr.message);
      return res.status(401).json({ success: false, error: 'Session expired or invalid. Please re-login.' });
    }

    const uid = decodedToken.uid;
    const userEmail = (decodedToken.email || "").toLowerCase().trim();

    // 6. Admin Role Check
    let isAdmin = false;
    if (userEmail) {
      try {
        const adminDoc = await db.collection('admins').doc(userEmail).get();
        isAdmin = adminDoc.exists;
      } catch (dbErr) {
        console.warn("Admin collection check skipped:", dbErr.message);
      }
    }

    // 7. Normal User 24-Hour Cooldown Validation
    if (!isAdmin) {
      try {
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
              success: false,
              error: `Daily limit reached. Normal accounts can only publish 1 book per 24 hours. Wait ${remainingHours} hour(s).`
            });
          }
        }
      } catch (cooldownErr) {
        console.error("Cooldown validation skipped:", cooldownErr.message);
      }
    }

    // 8. File Size Validation (Normal: 250MB, Admin: 1GB)
    const MAX_USER_SIZE = 250 * 1024 * 1024;
    const MAX_ADMIN_SIZE = 1024 * 1024 * 1024;
    const allowedLimit = isAdmin ? MAX_ADMIN_SIZE : MAX_USER_SIZE;

    const numericFileSize = Number(fileSize);
    if (numericFileSize && numericFileSize > allowedLimit) {
      const limitText = isAdmin ? "1 GB" : "250 MB";
      return res.status(403).json({ 
        success: false,
        error: `File size exceeds allowed limit. Maximum allowed: ${limitText}.` 
      });
    }

    // 9. Generate Safe R2 Key
    const folderPrefix = fileType === 'image' ? 'covers' : 'pdfs';
    const cleanExt = (fileName || "").split('.').pop().toLowerCase() || (fileType === 'image' ? 'jpg' : 'pdf');
    const randomHex = crypto.randomBytes(4).toString('hex');
    const cleanBaseName = (fileName || "file")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 12);

    const safeKey = `${folderPrefix}/${Date.now()}_${uid.slice(0, 5)}_${randomHex}_${cleanBaseName}.${cleanExt}`;
    const bucketName = process.env.R2_BUCKET_NAME || 'spidy-books';

    // 10. Generate Presigned PUT URL
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: safeKey,
    });

    const uploadUrl = await getSignedUrl(s3, command, { 
      expiresIn: 3600
    });

    return res.status(200).json({ 
      success: true,
      uploadUrl: uploadUrl, 
      fileKey: safeKey,
      isAdmin: isAdmin
    });

  } catch (error) {
    console.error("Server Handler Fatal Error:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message || 'Internal server error while generating upload link.' 
    });
  }
};
