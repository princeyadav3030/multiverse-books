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

    const snap = await db.collection('users')
      .orderBy('timeSpentSeconds', 'desc')
      .limit(100)
      .get();

    let rank = 1;
    let found = false;
    let totalSeconds = 0;

    snap.docs.forEach((doc, index) => {
      if (doc.id === myUid) {
        rank = index + 1;
        found = true;
        totalSeconds = doc.data().timeSpentSeconds || 0;
      }
    });

    if (!found) {
      const myDoc = await db.collection('users').doc(myUid).get();
      totalSeconds = myDoc.exists ? (myDoc.data().timeSpentSeconds || 0) : 0;
      rank = 100;
    }

    return res.status(200).json({
      success: true,
      rank: found ? rank : '100+',
      totalMinutes: Math.floor(totalSeconds / 60)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

