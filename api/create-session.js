// File: api/create-session.js

const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  // CORS Headers set karein taaki client direct connect kar sake
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
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                  req.socket?.remoteAddress || 
                  'unknown';

    // 2. Short, URL-safe session token (Bina kisi special character ke taaki shortener strip na kare)
    const randomHex = crypto.randomBytes(6).toString('hex').toLowerCase();
    const sessionId = `s${timestamp}${randomHex}`;

    // 3. Firestore me session save karein
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      clientIp: rawIp,
      fingerprint: fingerprint || 'unknown',
      timestamp: timestamp,
      // Anti-Bot: Minimum 10 seconds traversal time
      unlocksAt: timestamp + (10 * 1000),
      // Valid for 20 minutes
      expiresAt: timestamp + (20 * 60 * 1000),
      consumed: false,
      createdAt: timestamp
    });

    // 4. Return clean session
    return res.status(200).json({
      success: true,
      session: sessionId
    });

  } catch (error) {
    console.error("Session Creation Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to create session' 
    });
  }
};
