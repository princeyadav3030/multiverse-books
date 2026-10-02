// File: api/create-session.js

const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const { fingerprint } = req.body || {};
    const timestamp = Date.now();

    // 1. Client IP capture karein
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.socket?.remoteAddress || 
                     'unknown';

    // 2. Ek solid random secret token banayein
    const sessionSecret = crypto.randomBytes(16).toString('hex');
    const sessionId = `SES_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;

    // 3. Firestore me session record karein
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      sessionSecret: sessionSecret,
      clientIp: clientIp,
      fingerprint: fingerprint || 'unknown',
      timestamp: timestamp,
      unlocksAt: timestamp + (12 * 1000),      // 12 seconds anti-bot delay
      expiresAt: timestamp + (20 * 60 * 1000), // 20 minutes validity
      consumed: false,
      createdAt: timestamp
    });

    // 4. Browser me Secure HTTP Cookie set karein jo redirects me delete nahi hoti
    // Max-Age 20 minutes (1200 seconds)
    const cookiePayload = JSON.stringify({ sid: sessionId, sec: sessionSecret });
    const encodedCookie = Buffer.from(cookiePayload).toString('base64');

    res.setHeader('Set-Cookie', [
      `spidy_flow_session=${encodedCookie}; Path=/; Max-Age=1200; SameSite=Lax; HttpOnly; Secure`
    ]);

    return res.status(200).json({
      success: true,
      session: sessionId,
      flowToken: encodedCookie
    });

  } catch (error) {
    console.error("Create Session Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to create session' 
    });
  }
};
