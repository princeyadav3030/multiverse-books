// File: api/verify.js

const { db } = require('../utils/firebaseAdmin');
const { serialize } = require('cookie');

module.exports = async function handler(req, res) {
  // Sirf POST request allow karein
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const { token, fingerprint } = req.body || {};

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    // Clean token input
    const cleanToken = token.trim();
    let targetDoc = null;

    // 1. Direct Document ID match
    const directDocRef = db.collection('tokens').doc(cleanToken);
    const directDocSnap = await directDocRef.get();

    if (directDocSnap.exists) {
      targetDoc = directDocSnap;
    } else {
      // 2. Query fallback (Agar token document ID random ho aur andar 'token' field ho)
      const querySnap = await db.collection('tokens')
        .where('token', '==', cleanToken)
        .limit(1)
        .get();

      if (!querySnap.empty) {
        targetDoc = querySnap.docs[0];
      }
    }

    if (!targetDoc || !targetDoc.exists) {
      return res.status(400).json({ success: false, error: 'Invalid Token! Please get a valid key.' });
    }

    const data = targetDoc.data();
    const now = Date.now();

    // Check 1: Admin ne Revoke toh nahi kiya
    if (data.status === 'Revoked') {
      return res.status(400).json({ success: false, error: 'This token has been revoked by admin!' });
    }

    // Check 2: Expiration Check (Timestamp ya Milliseconds dono handle karega)
    let expiryMs = 0;
    if (data.expiresAt && typeof data.expiresAt.toMillis === 'function') {
      expiryMs = data.expiresAt.toMillis();
    } else if (typeof data.expiresAt === 'number') {
      expiryMs = data.expiresAt;
    } else if (data.expiresAt) {
      expiryMs = Number(data.expiresAt);
    }

    if (expiryMs > 0 && now > expiryMs) {
      return res.status(400).json({ success: false, error: 'Token expired! Please generate a new key.' });
    }

    // Check 3: Device Binding & Anti-Share Lock (Asli Security)
    const existingBoundFp = data.deviceBound || data.boundFingerprint || null;
    const currentFp = fingerprint ? String(fingerprint).trim() : null;

    if (existingBoundFp && currentFp) {
      // Agar pehle kisi device se bind ho chuka hai, toh naya device allow nahi hoga
      if (existingBoundFp !== currentFp) {
        return res.status(403).json({ 
          success: false, 
          error: 'Device Mismatch! This key is locked to another device and cannot be shared.' 
        });
      }
    }

    // Check 4: Multi-User / Max Uses Support (Admin Created Tokens ke liye)
    const maxUses = Number(data.maxUses) || 1;
    let currentUses = Number(data.currentUses) || 0;

    // Agar token pehli baar kisi device se attach ho raha hai
    if (!existingBoundFp) {
      if (currentUses >= maxUses) {
        return res.status(400).json({ success: false, error: 'Token usage limit exceeded!' });
      }
      currentUses += 1;
    }

    // User ka IP Address capture karein
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown_ip';

    // Database me token ko activate aur device lock karein
    const updateData = {
      isActivated: true,
      lastVerifiedAt: now,
      currentUses: currentUses
    };

    // Pehli baar verify hone par permanently device bind karein
    if (!existingBoundFp && currentFp) {
      updateData.deviceBound = currentFp;
      updateData.boundFingerprint = currentFp;
      updateData.boundIp = ip;
    }

    // Agar multi-use max limit hit ho jaye
    if (currentUses >= maxUses) {
      updateData.used = true;
    }

    await targetDoc.ref.update(updateData);

    // Browser ke liye 10 Din ki Secure Cookie set karein
    const cookie = serialize('spidy_auth', `verified_${cleanToken}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 24 * 60 * 60, // 10 Days
      path: '/'
    });

    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ 
      success: true, 
      message: 'Access Granted! Valid for 10 Days.',
      token: cleanToken,
      expiresAt: expiryMs || (now + (10 * 24 * 60 * 60 * 1000))
    });

  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(500).json({ success: false, error: 'Internal server verification error' });
  }
};
