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
    const myUid = decoded.uid;

    // 1. Current user ka time nikalen
    const myUserDoc = await db.collection('users').doc(myUid).get();
    let myTime = 0;
    if (myUserDoc.exists) {
      myTime = myUserDoc.data().timeSpentSeconds || 0;
    }

    // 2. Count kitne logon ka time current user se zyada hai
    // Efficient Firestore count query (No heavy reads)
    const higherUsersSnap = await db.collection('users')
      .where('timeSpentSeconds', '>', myTime)
      .count()
      .get();

    const usersAboveCount = higherUsersSnap.data().count;
    let rankNumber = usersAboveCount + 1;

    let displayRank;
    if (rankNumber <= 1000) {
      displayRank = rankNumber;
    } else {
      displayRank = '1K+';
    }

    return res.status(200).json({
      success: true,
      rank: displayRank,
      totalSeconds: myTime,
      totalMinutes: Math.floor(myTime / 60)
    });
  } catch (err) {
    console.error("Rank calculation error:", err);
    return res.status(500).json({ error: err.message });
  }
};
