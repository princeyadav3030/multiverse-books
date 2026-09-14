const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const { fingerprint } = req.body || {};
    const SECRET = process.env.SHORTLINK_AUTH_SECRET || "SPIDY_BYPASS_SHIELD_99";

    const timestamp = Date.now();
    const randomHex = crypto.randomBytes(8).toString('hex').toUpperCase();
    const sessionId = `REQ_${timestamp}_${randomHex}`;

    // Cryptographic HMAC Signature generate karein
    const signature = crypto
      .createHmac('sha256', SECRET)
      .update(`${sessionId}_${timestamp}`)
      .digest('hex');

    // 10 minutes session life (Firestore me save karein)
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      signature: signature,
      timestamp: timestamp,
      expiresAt: timestamp + (10 * 60 * 1000), // 10 minutes expiry
      fingerprint: fingerprint || 'unknown',
      consumed: false,
      createdAt: timestamp
    });

    // Signed parameters client ko return karein
    return res.status(200).json({
      success: true,
      session: sessionId,
      sig: signature,
      ts: timestamp
    });

  } catch (error) {
    console.error("Create Session Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to initialize secure session handshake' 
    });
  }
};

