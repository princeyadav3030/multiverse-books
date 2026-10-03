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

    const cleanToken = token.trim();
    const now = Date.now();
    const currentFp = fingerprint ? String(fingerprint).trim() : 'unknown_device';
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown_ip';

    let targetDoc = null;

    // 1. Direct Document ID match
    const directDocRef = db.collection('tokens').doc(cleanToken);
    const directDocSnap = await directDocRef.get();

    if (directDocSnap.exists) {
      targetDoc = directDocSnap;
    } else {
      // 2. Query fallback match
      const querySnap = await db.collection('tokens')
        .where('token', '==', cleanToken)
        .limit(1)
        .get();

      if (!querySnap.empty) {
        targetDoc = querySnap.docs[0];
      }
    }

    // 3. AUTO-RECOVERY: Agar navigation redirect ki wajah se Firestore write miss ho gaya ho
    if (!targetDoc || !targetDoc.exists) {
      // Token format check: 'SPIDY-' se shuru aur length kam se kam 15 ho
      if (cleanToken.startsWith('SPIDY-') && cleanToken.length >= 15) {
        const expiresAt = now + (10 * 24 * 60 * 60 * 1000); // 10 Din

        await db.collection('tokens').doc(cleanToken).set({
          token: cleanToken,
          used: false,
          createdAt: now,
          expiresAt: expiresAt,
          deviceBound: currentFp,
          boundFingerprint: currentFp,
          boundIp: ip,
          isActivated: true,
          lastVerifiedAt: now,
          source: 'recovered_shortlink_generated'
        });

        // Set 10-day cookie
        const cookie = serialize('spidy_auth', `verified_${cleanToken}`, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 10 * 24 * 60 * 60,
          path: '/'
        });

        res.setHeader('Set-Cookie', cookie);
        return res.status(200).json({
          success: true,
          message: 'Access Granted! Valid for 10 Days.',
          token: cleanToken,
          expiresAt: expiresAt
        });
      } else {
        return res.status(400).json({ success: false, error: 'Invalid Token! Please get a valid key.' });
      }
    }

    const data = targetDoc.data();

    // Check 1: Admin Revocation
    if (data.status === 'Revoked') {
      return res.status(400).json({ success: false, error: 'This token has been revoked by admin!' });
    }

    // Check 2: Expiry Check
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

    // Check 3: Device Binding (Anti-Share)
    const existingBoundFp = data.deviceBound || data.boundFingerprint || null;

    if (existingBoundFp && currentFp) {
      if (existingBoundFp !== currentFp) {
        return res.status(403).json({ 
          success: false, 
          error: 'Device Mismatch! This key is locked to another device.' 
        });
      }
    }

    // Check 4: Multi-User / Max Uses Support
    const maxUses = Number(data.maxUses) || 1;
    let currentUses = Number(data.currentUses) || 0;

    if (!existingBoundFp) {
      if (currentUses >= maxUses) {
        return res.status(400).json({ success: false, error: 'Token usage limit exceeded!' });
      }
      currentUses += 1;
    }

    // Database update & Device Lock
    const updateData = {
      isActivated: true,
      lastVerifiedAt: now,
      currentUses: currentUses
    };

    if (!existingBoundFp && currentFp) {
      updateData.deviceBound = currentFp;
      updateData.boundFingerprint = currentFp;
      updateData.boundIp = ip;
    }

    if (currentUses >= maxUses) {
      updateData.used = true;
    }

    await targetDoc.ref.update(updateData);

    const cookie = serialize('spidy_auth', `verified_${cleanToken}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 24 * 60 * 60,
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
