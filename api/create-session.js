// File: api/create-session.js

const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  // Sirf POST requests allow karein
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      error: 'Method Not Allowed' 
    });
  }

  try {
    const { fingerprint } = req.body || {};
    const timestamp = Date.now();

    // 1. Client IP capture karein (Proxy/CDN safe header parsing)
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                  req.socket?.remoteAddress || 
                  'unknown';

    // 2. User-Agent extract karein
    const userAgent = (req.headers['user-agent'] || 'unknown').slice(0, 150);

    // 3. Network Subnet Signature (Mobile Network / Tower-switch safe)
    // IPv4 me first 2 octets match karta hai (e.g., 49.36.x.x) taaki session fail na ho
    let ipSubnet = 'unknown';
    if (rawIp.includes('.')) {
      ipSubnet = rawIp.split('.').slice(0, 2).join('.');
    } else if (rawIp.includes(':')) {
      ipSubnet = rawIp.split(':').slice(0, 3).join(':'); // IPv6 subnet support
    }

    // 4. Secure Random Session Identifier
    const randomHex = crypto.randomBytes(8).toString('hex').toUpperCase();
    const sessionId = `REQ_${timestamp}_${randomHex}`;

    // 5. Firestore me pending verification session record karein
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      clientIp: rawIp,
      ipSubnet: ipSubnet,
      userAgent: userAgent,
      fingerprint: fingerprint || 'unknown',
      timestamp: timestamp,
      // Anti-Bypass Security: Minimum 12 seconds link traversal delay
      unlocksAt: timestamp + (12 * 1000),
      // Expiry Window: 15 minutes
      expiresAt: timestamp + (15 * 60 * 1000),
      consumed: false,
      createdAt: timestamp
    });

    // 6. Client ko valid Session ID bhejein
    return res.status(200).json({
      success: true,
      session: sessionId
    });

  } catch (error) {
    console.error("Create Session Execution Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to initialize session gateway' 
    });
  }
};
