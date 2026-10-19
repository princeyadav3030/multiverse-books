// File: api/generate-upload-url.js

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
    console.error("Firebase Admin Init Error:", err.message);
  }
}

const db = admin.firestore();

// ==========================================
// 2. CLOUDFLARE R2 S3 CLIENT (CHECKSUM OPTIMIZED)
// ==========================================
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
  // Naye AWS SDK v3 me 0% upload drop issue prevent karne ke liye:
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED"
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
      return res.status(401).json({ success: false, error: 'Please log in first to continue.' });
    }

    if (!fileName || !fileSize) {
      return res.status(400).json({ success: false, error: 'Missing fileName or fileSize parameter.' });
    }

    // 1. User Identity & Token Verification
    let uid = null;
    let userEmail = "";
    try {
      const decodedToken = await admin.auth().verifyIdToken(userToken);
      uid = decodedToken.uid;
      userEmail = (decodedToken.email || "").toLowerCase().trim();
    } catch (authErr) {
      return res.status(401).json({ success: false, error: 'Authentication session expired. Please re-login.' });
    }

    // 2. Strict Super Admin Check (Admins Collection Mapping)
    let isAdmin = false;
    if (userEmail) {
      try {
        const adminDoc = await db.collection('admins').doc(userEmail).get();
        isAdmin = adminDoc.exists;
      } catch (e) {
        console.warn("Admin check skipped:", e.message);
      }
    }

    // 3. Community Daily Upload Limit (24-Hour Cooldown for Normal Users)
    if (!isAdmin) {
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          const lastUpload = userDoc.data().lastBookUploadTime || 0;
          const ONE_DAY_MS = 24 * 60 * 60 * 1000;
          const diff = Date.now() - lastUpload;
          if (diff < ONE_DAY_MS) {
            const remainingHours = Math.ceil((ONE_DAY_MS - diff) / (1000 * 60 * 60));
            return res.status(403).json({
              success: false,
              error: `Daily Community Upload Limit Reached: To ensure fair access and top quality, you can publish 1 book every 24 hours. Please check back in ${remainingHours} hour(s) to share your next study material! 📚✨`
            });
          }
        }
      } catch (e) {}
    }

    // 4. Exact File Size Guard (Admin: 1 GB, Normal User: 250 MB)
    const MAX_ADMIN_BYTES = 1024 * 1024 * 1024; // 1 GB
    const MAX_USER_BYTES = 250 * 1024 * 1024;   // 250 MB
    const maxAllowedLimit = isAdmin ? MAX_ADMIN_BYTES : MAX_USER_BYTES;

    const parsedFileSize = Number(fileSize);
    if (isNaN(parsedFileSize) || parsedFileSize <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid file size detected.' });
    }

    if (parsedFileSize > maxAllowedLimit) {
      return res.status(403).json({
        success: false,
        error: `File size exceeds the allowed limit (${isAdmin ? "1 GB" : "250 MB"}). Please optimize your file before uploading.`
      });
    }

    // 5. Clean File Key & Folder Partitioning
    const folderPrefix = fileType === 'image' ? 'covers' : 'pdfs';
    const cleanExt = (fileName || "").split('.').pop().toLowerCase() || (fileType === 'image' ? 'jpg' : 'pdf');
    const randomHex = crypto.randomBytes(4).toString('hex');
    const cleanBase = (fileName || "file")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 15);
    
    // Structure: covers/{timestamp}_{uid}_{random}_{name}.ext
    const safeKey = `${folderPrefix}/${Date.now()}_${uid.slice(0, 5)}_${randomHex}_${cleanBase}.${cleanExt}`;
    const bucketName = process.env.R2_BUCKET_NAME || 'spidy-books';

    // 6. Strict MIME Type Lock
    const finalMime = mimeType || (fileType === 'image' ? 'image/jpeg' : 'application/pdf');

    // 7. Generate Pre-signed Direct S3/R2 PUT URL (Valid for 1 Hour)
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
      isAdmin: isAdmin,
      maxAllowedLimit: maxAllowedLimit
    });

  } catch (error) {
    console.error("Generate Upload URL Error:", error);
    return res.status(500).json({ success: false, error: 'Storage API Error: ' + (error.message || 'Server error') });
  }
};

