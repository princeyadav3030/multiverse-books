const admin = require('firebase-admin');

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
    console.error("Firebase Admin Error:", e);
  }
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { userToken } = req.body;
  if (!userToken) return res.status(400).json({ error: 'Missing token' });

  try {
    const decoded = await admin.auth().verifyIdToken(userToken);
    const uid = decoded.uid;
    const userRef = db.collection('users').doc(uid);

    await userRef.set({
      timeSpentSeconds: admin.firestore.FieldValue.increment(60),
      lastSeen: Date.now()
    }, { merge: true });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
};

