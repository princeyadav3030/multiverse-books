const admin = require('firebase-admin');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// 1. Firebase Admin Initialization
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

// 2. Cloudflare R2 Client Setup
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = async function handler(req, res) {
  // CORS & Preflight Handling
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { fileName, fileSize, userToken } = req.body;

  if (!userToken) {
    return res.status(401).json({ error: 'Unauthorized: User login zaroori hai.' });
  }

  try {
    // 3. User Authentication & Role Verification
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    const userEmail = (decodedToken.email || "").toLowerCase().trim();

    let isAdmin = false;
    if (userEmail) {
      const adminDoc = await db.collection('admins').doc(userEmail).get();
      isAdmin = adminDoc.exists;
    }

    // 4. File Size Constraints (Admin: 1GB, Normal User: 250MB)
    const MAX_USER_SIZE = 250 * 1024 * 1024;   // 250 MB
    const MAX_ADMIN_SIZE = 1024 * 1024 * 1024; // 1 GB (1024 MB)
    const allowedLimit = isAdmin ? MAX_ADMIN_SIZE : MAX_USER_SIZE;

    const numericFileSize = Number(fileSize);
    if (numericFileSize && numericFileSize > allowedLimit) {
      const limitText = isAdmin ? "1 GB" : "250 MB";
      return res.status(403).json({ 
        error: `File size limit se zyada hai! Maximum limit: ${limitText} hai.` 
      });
    }

    const bucketName = process.env.R2_BUCKET_NAME || 'spidy-books';

    // 5. Zero-Header Direct Presigned URL Generation
    // ContentType ko sign nahi kiya taaki browser binary push me signature clash na ho
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName
    });

    const uploadUrl = await getSignedUrl(s3, command, { 
      expiresIn: 7200,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32'])
    });

    return res.status(200).json({ 
      success: true,
      uploadUrl: uploadUrl, 
      fileKey: fileName 
    });

  } catch (error) {
    console.error("Upload URL Handler Error:", error);
    return res.status(500).json({ 
      error: error.message || 'Presigned URL generate karne me error aaya.' 
    });
  }
};
