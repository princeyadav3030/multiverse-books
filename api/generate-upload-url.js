const admin = require('firebase-admin');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Firebase Admin Initialize (Singleton Pattern)
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
  } catch (e) {
    console.error("Firebase Admin init error:", e);
  }
}
const db = admin.firestore();

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = async function handler(req, res) {
  // CORS configuration (Compatible with Fetch & XHR)
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { fileName, userToken } = req.body;
  if (!fileName || !userToken) {
    return res.status(400).json({ error: 'Missing parameters: fileName and userToken are required' });
  }

  try {
    // 1. Verify User Token
    const decodedToken = await admin.auth().verifyIdToken(userToken);
    const userEmail = (decodedToken.email || "").toLowerCase().trim();

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized: No valid email associated with token' });
    }

    // 2. Admin Check against Firestore 'admins' collection
    const adminDoc = await db.collection('admins').doc(userEmail).get();
    if (!adminDoc.exists) {
      return res.status(403).json({ error: 'Access Denied: Only admins can upload files!' });
    }

    // 3. Clean File Path Construction
    let finalKey = fileName;
    if (fileName.includes('/')) {
      const parts = fileName.split('/');
      const folder = parts[0]; // 'covers' or 'pdfs'
      const originalName = parts.slice(1).join('/');
      finalKey = `${folder}/${Date.now()}_${originalName.replace(/\s+/g, '-')}`;
    } else {
      finalKey = `uploads/${Date.now()}_${fileName.replace(/\s+/g, '-')}`;
    }

    // 4. Generate Presigned URL without forcing ContentType constraint into signature
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: finalKey,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return res.status(200).json({ 
      success: true, 
      uploadUrl, 
      fileKey: finalKey 
    });

  } catch (error) {
    console.error("Upload URL Generation Error:", error);
    return res.status(500).json({ 
      error: 'Failed to generate upload URL: ' + (error.message || error) 
    });
  }
};
