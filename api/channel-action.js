// File: api/channel-action.js

const admin = require('firebase-admin');

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
  } catch (e) {
    console.error("Firebase Admin Error:", e);
  }
}

const db = admin.firestore();

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });

  let bodyData = req.body;
  if (typeof bodyData === 'string') {
    try {
      bodyData = JSON.parse(bodyData);
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
    }
  }

  const { type, postId, emoji, userToken } = bodyData || {};
  if (!type || !postId || !userToken) {
    return res.status(400).json({ success: false, error: 'Missing required parameters' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(userToken);
    const uid = decoded.uid;
    const postRef = db.collection('channel_posts').doc(postId);

    // ==========================================
    // 1. UNIQUE VIEW CONTROLLER (1 VIEW PER USER)
    // ==========================================
    if (type === 'view') {
      const viewerRef = postRef.collection('viewers').doc(uid);
      await db.runTransaction(async (t) => {
        const viewerDoc = await t.get(viewerRef);
        if (!viewerDoc.exists) {
          t.set(viewerRef, { viewedAt: Date.now() });
          t.update(postRef, { views: admin.firestore.FieldValue.increment(1) });
        }
      });
      return res.status(200).json({ success: true, message: 'View counted successfully' });
    }

    // ==========================================
    // 2. DYNAMIC REACTION TOGGLE & CONTROLLER
    // ==========================================
    if (type === 'reaction') {
      if (!emoji) return res.status(400).json({ success: false, error: 'Emoji is required' });
      const reactionRef = postRef.collection('reactions').doc(uid);

      await db.runTransaction(async (t) => {
        const [postDoc, reactionDoc] = await Promise.all([
          t.get(postRef),
          t.get(reactionRef)
        ]);

        if (!postDoc.exists) {
          throw new Error('POST_NOT_FOUND');
        }

        const currentReactions = postDoc.data().reactions || {};

        if (!reactionDoc.exists) {
          // Naya reaction add karein
          t.set(reactionRef, { emoji: emoji, updatedAt: Date.now() });
          t.update(postRef, {
            [`reactions.${emoji}`]: admin.firestore.FieldValue.increment(1)
          });
        } else {
          const oldEmoji = reactionDoc.data().emoji;
          if (oldEmoji === emoji) {
            // Agar same emoji dubara click hua toh kuch na badle
            return;
          }

          // Purane emoji ka count -1 aur naye emoji ka count +1 karein
          const updates = {};
          if (currentReactions[oldEmoji] && currentReactions[oldEmoji] > 0) {
            updates[`reactions.${oldEmoji}`] = admin.firestore.FieldValue.increment(-1);
          }
          updates[`reactions.${emoji}`] = admin.firestore.FieldValue.increment(1);

          t.update(reactionRef, { emoji: emoji, updatedAt: Date.now() });
          t.update(postRef, updates);
        }
      });

      return res.status(200).json({ success: true, message: 'Reaction updated successfully' });
    }

    return res.status(400).json({ success: false, error: 'Invalid action type' });

  } catch (err) {
    if (err.message === 'POST_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Target post not found' });
    }
    console.error("Channel Action Error:", err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
};
