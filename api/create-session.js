const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const { fingerprint } = req.body || {};
    const timestamp = Date.now();
    
    // Unique Session ID aur Secure Client Secret generate karein
    const randomHex = crypto.randomBytes(8).toString('hex').toUpperCase();
    const sessionId = `REQ_${timestamp}_${randomHex}`;
    const secretKey = crypto.randomBytes(24).toString('hex');

    // Firestore me pending session save karein
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      secretKey: secretKey,
      timestamp: timestamp,
      // Anti-Fast-Bypass: Kam se kam 35 seconds ads me lagne chahiye
      unlocksAt: timestamp + (35 * 1000),
      expiresAt: timestamp + (10 * 60 * 1000), // 10 minutes expiry
      fingerprint: fingerprint || 'unknown',
      consumed: false,
      createdAt: timestamp
    });

    // Browser ke andar HttpOnly Secure Cookie lock karein (Bypasser isse copy nahi kar sakta)
    res.setHeader('Set-Cookie', [
      `spidy_handshake=${secretKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`
    ]);

    // Client ko session ID return karein
    return res.status(200).json({
      success: true,
      session: sessionId
    });

  } catch (error) {
    console.error("Create Session Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to initialize secure session handshake' 
    });
  }
};
