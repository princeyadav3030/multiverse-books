const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const { fingerprint } = req.body || {};
    const timestamp = Date.now();

    // User ka Real Client IP aur User-Agent pakdein
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.socket?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Unique secure session ID generate karein
    const randomHex = crypto.randomBytes(6).toString('hex').toUpperCase();
    const sessionId = `REQ_${timestamp}_${randomHex}`;

    // Firestore me pending session save karein (IP & Device Lock)
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      clientIp: clientIp,
      userAgent: userAgent,
      fingerprint: fingerprint || 'unknown',
      timestamp: timestamp,
      // Anti-Fast Bypass: Minimum 12 seconds delay rakha hai
      unlocksAt: timestamp + (12 * 1000), 
      expiresAt: timestamp + (10 * 60 * 1000), // 10 minute tak valid
      consumed: false,
      createdAt: timestamp
    });

    // Client ko session ID return karein
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
