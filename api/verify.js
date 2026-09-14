const { db } = require('../utils/firebaseAdmin');
const { serialize } = require('cookie');

module.exports = async function handler(req, res) {
  // Sirf POST request allow karein
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { token, fingerprint } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Clean input (spaces hatana aur exact compare ke liye trim karna)
    const cleanToken = token.trim();
    let targetDoc = null;

    // 1. Check: Direct Document ID match (Standard format jaise generate.js banata hai)
    const directDocRef = db.collection('tokens').doc(cleanToken);
    const directDocSnap = await directDocRef.get();

    if (directDocSnap.exists) {
      targetDoc = directDocSnap;
    } else {
      // 2. Fallback Check: Query by 'token' field (Agar token random ID ke andar field ho)
      const querySnap = await db.collection('tokens')
        .where('token', '==', cleanToken)
        .limit(1)
        .get();

      if (!querySnap.empty) {
        targetDoc = querySnap.docs[0];
      }
    }

    // Agar token dono me se kisi tarah nahi mila
    if (!targetDoc || !targetDoc.exists) {
      return res.status(400).json({ error: 'Invalid Token! Please get a new key.' });
    }

    const data = targetDoc.data();
    const now = Date.now();

    // Check 1: Revoked Status
    if (data.status === 'Revoked') {
      return res.status(400).json({ error: 'This token has been revoked by admin!' });
    }

    // Check 2: Expiration Time Check (Number aur Timestamp dono handle karega)
    let expiryMs = 0;
    if (data.expiresAt && typeof data.expiresAt.toMillis === 'function') {
      expiryMs = data.expiresAt.toMillis();
    } else if (typeof data.expiresAt === 'number') {
      expiryMs = data.expiresAt;
    } else if (data.expiresAt) {
      expiryMs = Number(data.expiresAt);
    }

    if (expiryMs > 0 && now > expiryMs) {
      return res.status(400).json({ error: 'Token expired! Please generate a new key.' });
    }

    // Check 3: Usage Limit Check (Single-use 'used: true' aur Multi-use 'currentUses >= maxUses' dono support karega)
    const maxUses = Number(data.maxUses) || 1;
    const currentUses = Number(data.currentUses) || 0;

    if (data.used === true || currentUses >= maxUses) {
      return res.status(400).json({ error: 'Token already used or limit exceeded!' });
    }

    // User ka IP Address nikalna
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown_ip';

    // Database me token ko USED aur DEVICE BOUND mark karein
    await targetDoc.ref.update({
      used: true,
      currentUses: currentUses + 1,
      usedAt: now,
      boundFingerprint: fingerprint || 'unknown',
      boundIp: ip
    });

    // Browser ke liye secure HTTPOnly cookie set karein
    const cookie = serialize('spidy_auth', `verified_${cleanToken}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 10 * 24 * 60 * 60, // 10 Days valid cookie
      path: '/'
    });

    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ 
      success: true, 
      message: 'Device Verified & Locked Successfully!',
      token: cleanToken 
    });

  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(500).json({ error: 'Internal server verification error' });
  }
};
