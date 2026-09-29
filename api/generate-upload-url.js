const admin = require('firebase-admin');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

// ==========================================
// 1. FIREBASE PRIVATE KEY PARSER
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

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: getCleanPrivateKey(),
      }),
    });
  } catch (err) {
    console.error("Firebase Init Error:", err.message);
  }
}

const db = admin.firestore();

// ==========================================
// 2. CLOUDFLARE R2 S3 CLIENT
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
// 3. MAIN API HANDLER
// ==========================================
module.exports = async function handler(req, res) {
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
    let bodyData = req.body;
    if (typeof bodyData === 'string') {
      try {
        bodyData = JSON.parse(bodyData);
      } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
      }
    }

    const { fileName, fileSize, userToken, fileType, mimeType } = bodyData || {};

    if (!userToken) {
      return res.status(401).json({ success: false, error: 'Please log in first.' });
    }

    // User verify
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    const uid = decodedToken.uid;
    const userEmail = (decodedToken.email || "").toLowerCase().trim();

    // Admin role check
    let isAdmin = false;
    if (userEmail) {
      try {
        const adminDoc = await db.collection('admins').doc(userEmail).get();
        isAdmin = adminDoc.exists;
      } catch (e) {}
    }

    // 24-Hour Cooldown (Normal user only)
    if (!isAdmin) {
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          const lastUpload = userDoc.data().lastBookUploadTime || 0;
          const ONE_DAY_MS = 24 * 60 * 60 * 1000;
          const diff = Date.now() - lastUpload;
          if (diff < ONE_DAY_MS) {
            const hours = Math.ceil((ONE_DAY_MS - diff) / (1000 * 60 * 60));
            return res.status(403).json({
              success: false,
              error: `Normal users can only upload 1 book per 24 hours. Wait ${hours} hour(s).`
            });
          }
        }
      } catch (e) {}
    }

    // File size constraints (Normal: 250MB, Admin: 1GB)
    const allowedLimit = isAdmin ? (1024 * 1024 * 1024) : (250 * 1024 * 1024);
    if (Number(fileSize) > allowedLimit) {
      return res.status(403).json({
        success: false,
        error: `File size exceeds allowed limit (${isAdmin ? "1GB" : "250MB"}).`
      });
    }

    // File path & MIME type setting (Signature match lock)
    const folderPrefix = fileType === 'image' ? 'covers' : 'pdfs';
    const cleanExt = (fileName || "").split('.').pop().toLowerCase() || (fileType === 'image' ? 'jpg' : 'pdf');
    const randomHex = crypto.randomBytes(4).toString('hex');
    const cleanBase = (fileName || "file").replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
    const safeKey = `${folderPrefix}/${Date.now()}_${uid.slice(0, 5)}_${randomHex}_${cleanBase}.${cleanExt}`;
    const bucketName = process.env.R2_BUCKET_NAME || 'spidy-books';

    // Lock exact ContentType in AWS signature
    const finalMime = mimeType || (fileType === 'image' ? 'image/jpeg' : 'application/pdf');

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: safeKey,
      ContentType: finalMime,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return res.status(200).json({
      success: true,
      uploadUrl: uploadUrl,
      fileKey: safeKey,
      mimeType: finalMime,
      isAdmin: isAdmin
    });

  } catch (error) {
    console.error("API Error:", error.message);
    return res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
};
