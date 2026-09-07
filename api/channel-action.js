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

  const { type, postId, emoji, userToken } = req.body;
  if (!type || !postId || !userToken) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(userToken);
    const uid = decoded.uid;
    const postRef = db.collection('channel_posts').doc(postId);

    // 1. UNIQUE VIEW CONTROLLER
    if (type === 'view') {
      const viewerRef = postRef.collection('viewers').doc(uid);
      await db.runTransaction(async (t) => {
        const doc = await t.get(viewerRef);
        if (!doc.exists) {
          t.set(viewerRef, { viewedAt: Date.now() });
          t.update(postRef, { views: admin.firestore.FieldValue.increment(1) });
        }
      });
      return res.status(200).json({ success: true, message: 'View counted' });
    }

    // 2. PERMANENT SINGLE REACTION CONTROLLER
    if (type === 'reaction') {
      if (!emoji) return res.status(400).json({ error: 'Emoji is required' });
      const reactionRef = postRef.collection('reactions').doc(uid);

      await db.runTransaction(async (t) => {
        const doc = await t.get(reactionRef);
        if (doc.exists) {
          throw new Error('ALREADY_REACTED');
        }
        t.set(reactionRef, { emoji: emoji, createdAt: Date.now() });
        t.update(postRef, {
          [`reactions.${emoji}`]: admin.firestore.FieldValue.increment(1)
        });
      });

      return res.status(200).json({ success: true, message: 'Reaction saved' });
    }

    return res.status(400).json({ error: 'Invalid action type' });

  } catch (err) {
    if (err.message === 'ALREADY_REACTED') {
      return res.status(403).json({ error: 'Aap is post par pehle hi react kar chuke hain!' });
    }
    return res.status(500).json({ error: err.message });
  }
};

