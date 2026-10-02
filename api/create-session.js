const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const { fingerprint } = req.body || {};
    const timestamp = Date.now();

    // User IP address capture
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.socket?.remoteAddress || 'unknown';

    // Unique secure session ID generate karein
    const randomHex = crypto.randomBytes(6).toString('hex').toUpperCase();
    const sessionId = `REQ_${timestamp}_${randomHex}`;

    // Firestore me pending session save karein
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      clientIp: clientIp,
      fingerprint: fingerprint || 'unknown',
      timestamp: timestamp,
      // Kam se kam 10 seconds ads delay (anti-instant hit)
      unlocksAt: timestamp + (10 * 1000), 
      expiresAt: timestamp + (15 * 60 * 1000), // 15 minute expiry
      consumed: false,
      createdAt: timestamp
    });

    // Session ID return karein jo browser ke localStorage me lock hogi
    return res.status(200).json({
      success: true,
      session: sessionId
    });

  } catch (error) {
    console.error("Create Session Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to initialize session' 
    });
  }
};
