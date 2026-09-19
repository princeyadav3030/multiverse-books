const admin = require('firebase-admin');
const { 
  S3Client, 
  PutObjectCommand, 
  CreateMultipartUploadCommand, 
  UploadPartCommand, 
  CompleteMultipartUploadCommand 
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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
  } catch (err) {
    console.error("Firebase Admin Error:", err);
  }
}
const db = admin.firestore();

// Cloudflare R2 Client (S3 Compatible)
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { fileName, fileType, fileSize, userToken, action, uploadId, parts } = req.body;

  if (!userToken) {
    return res.status(401).json({ error: 'Unauthorized: User login zaroori hai.' });
  }

  try {
    // 1. User Token Verification
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    const userEmail = (decodedToken.email || "").toLowerCase().trim();

    // 2. Admin Check
    let isAdmin = false;
    if (userEmail) {
      const adminDoc = await db.collection('admins').doc(userEmail).get();
      isAdmin = adminDoc.exists;
    }

    // 3. Strict Size Limits (Normal User: 250MB, Admin: 1GB)
    const MAX_USER_SIZE = 250 * 1024 * 1024;   // 250 MB
    const MAX_ADMIN_SIZE = 1024 * 1024 * 1024; // 1 GB (1024 MB)
    const allowedLimit = isAdmin ? MAX_ADMIN_SIZE : MAX_USER_SIZE;

    if (fileSize && fileSize > allowedLimit) {
      const limitText = isAdmin ? "1 GB" : "250 MB";
      return res.status(403).json({ 
        error: `File size limit se zyada hai! Aapka maximum upload limit: ${limitText} hai.` 
      });
    }

    const bucketName = process.env.R2_BUCKET_NAME || 'spidy-books';

    // 4. Multipart Chunk Upload Handlers (Badi Files ke liye)
    if (action === "initiateMultipart") {
      const command = new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: fileName,
        ContentType: fileType,
      });
      const multipart = await s3.send(command);
      return res.status(200).json({ uploadId: multipart.UploadId, fileKey: fileName });
    }

    if (action === "getPartUrl") {
      const { partNumber } = req.body;
      const command = new UploadPartCommand({
        Bucket: bucketName,
        Key: fileName,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
      return res.status(200).json({ signedUrl });
    }

    if (action === "completeMultipart") {
      const command = new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: fileName,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      });
      await s3.send(command);
      return res.status(200).json({ success: true, fileKey: fileName });
    }

    // 5. Small File (<50MB) Single PUT Upload
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName,
      ContentType: fileType,
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return res.status(200).json({ uploadUrl, fileKey: fileName });

  } catch (error) {
    console.error("Upload Error:", error);
    return res.status(500).json({ error: error.message || 'Server error aa gaya.' });
  }
};
