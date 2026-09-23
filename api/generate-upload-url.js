const admin = require('firebase-admin');
const { 
  S3Client, 
  PutObjectCommand, 
  CreateMultipartUploadCommand, 
  UploadPartCommand, 
  CompleteMultipartUploadCommand 
} = require('@aws-sdk/client-s3');
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
    console.error("Firebase Admin Error:", err);
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
  // CORS & Preflight headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'ETag,Content-Length,Content-Range,Accept-Ranges');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { fileName, fileType, fileSize, userToken, action, uploadId, parts } = req.body;

  if (!userToken) {
    return res.status(401).json({ error: 'Unauthorized: User login zaroori hai.' });
  }

  try {
    // 3. User Authentication & Admin Verification
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    const userEmail = (decodedToken.email || "").toLowerCase().trim();

    let isAdmin = false;
    if (userEmail) {
      const adminDoc = await db.collection('admins').doc(userEmail).get();
      isAdmin = adminDoc.exists;
    }

    // 4. Strict File Size Validation
    const MAX_USER_SIZE = 250 * 1024 * 1024;   // 250 MB
    const MAX_ADMIN_SIZE = 1024 * 1024 * 1024; // 1 GB
    const allowedLimit = isAdmin ? MAX_ADMIN_SIZE : MAX_USER_SIZE;

    const numericFileSize = Number(fileSize);
    if (numericFileSize && numericFileSize > allowedLimit) {
      const limitText = isAdmin ? "1 GB" : "250 MB";
      return res.status(403).json({ 
        error: `File size limit se zyada hai! Aapka maximum limit: ${limitText} hai.` 
      });
    }

    const bucketName = process.env.R2_BUCKET_NAME || 'spidy-books';

    // 5. Multipart: Initiate Upload
    if (action === "initiateMultipart") {
      const command = new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: fileName,
        ContentType: fileType || 'application/octet-stream',
      });
      const multipart = await s3.send(command);
      return res.status(200).json({ uploadId: multipart.UploadId, fileKey: fileName });
    }

    // 6. Multipart: Get Signed Part URL
    if (action === "getPartUrl") {
      const { partNumber } = req.body;
      const parsedPartNumber = parseInt(partNumber, 10);
      
      if (!uploadId || isNaN(parsedPartNumber)) {
        return res.status(400).json({ error: "Invalid uploadId ya partNumber" });
      }

      // ContentType yahan specify nahi karna hai taaki binary chunk PUT reject na ho
      const command = new UploadPartCommand({
        Bucket: bucketName,
        Key: fileName,
        UploadId: uploadId,
        PartNumber: parsedPartNumber,
      });

      const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
      return res.status(200).json({ signedUrl });
    }

    // 7. Multipart: Complete Upload
    if (action === "completeMultipart") {
      if (!uploadId || !Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: "Parts payload missing ya invalid hai." });
      }

      const formattedParts = parts.map(p => ({
        PartNumber: parseInt(p.PartNumber, 10),
        ETag: p.ETag ? p.ETag.replace(/^"|"$/g, '') : ''
      })).sort((a, b) => a.PartNumber - b.PartNumber);

      const command = new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: fileName,
        UploadId: uploadId,
        MultipartUpload: { Parts: formattedParts },
      });

      await s3.send(command);
      return res.status(200).json({ success: true, fileKey: fileName });
    }

    // 8. Single Direct PUT (For Small Covers/Files < 50MB)
    // PutObjectCommand me ContentType sign nahi karenge taaki browser XHR direct PUT me signature drop na kare
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return res.status(200).json({ uploadUrl, fileKey: fileName });

  } catch (error) {
    console.error("Presigned URL Generation Error:", error);
    return res.status(500).json({ error: error.message || 'Server storage presigned error.' });
  }
};
