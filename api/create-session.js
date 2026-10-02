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

    // 1. Real Client IP capture karein
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                  req.socket?.remoteAddress || 
                  'unknown';

    // 2. Subnet Signature (Mobile 4G/5G tower shifts ke liye safe)
    let ipSubnet = 'unknown';
    if (rawIp.includes('.')) {
      ipSubnet = rawIp.split('.').slice(0, 2).join('.');
    } else if (rawIp.includes(':')) {
      ipSubnet = rawIp.split(':').slice(0, 3).join(':');
    }

    const randomHex = crypto.randomBytes(4).toString('hex').toLowerCase();
    const sessionId = `SES_${timestamp}_${randomHex}`;

    // 3. Firestore me session lock karein
    // Anti-Bypass: Kam se kam 12 seconds link traversal delay
    // Expiry: 20 minutes
    await db.collection('pending_sessions').doc(sessionId).set({
      sessionId: sessionId,
      clientIp: rawIp,
      ipSubnet: ipSubnet,
      fingerprint: fingerprint || 'unknown',
      timestamp: timestamp,
      unlocksAt: timestamp + (12 * 1000),      
      expiresAt: timestamp + (20 * 60 * 1000), 
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
      error: 'Failed to initialize session' 
    });
  }
};
