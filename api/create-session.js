const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const timestamp = Date.now();
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.socket?.remoteAddress || 'unknown';

    const randomHex = crypto.randomBytes(6).toString('hex').toUpperCase();
    const sessionId = `REQ_${timestamp}_${randomHex}`;

    // Pending session save karein
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      clientIp: clientIp,
      timestamp: timestamp,
      unlocksAt: timestamp + (8 * 1000), // Sirf 8s safety buffer
      expiresAt: timestamp + (15 * 60 * 1000), // 15 mins expiry
      consumed: false,
      createdAt: timestamp
    });

    return res.status(200).json({
      success: true,
      session: sessionId
    });

  } catch (error) {
    console.error("Create Session Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to create session' 
    });
  }
};
