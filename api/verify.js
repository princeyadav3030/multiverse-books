// File: api/verify.js

const { db } = require('../utils/firebaseAdmin');

module.exports = async function handler(req, res) {
  // CORS Headers
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
    const { token, fingerprint } = req.body || {};

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    const cleanToken = String(token).trim();
    const now = Date.now();
    const currentFp = fingerprint ? String(fingerprint).trim() : 'device_bound';
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown_ip';

    let targetDoc = null;

    // 1. Database check (Agar Firebase connect ho sake)
    if (db) {
      try {
        const directDocRef = db.collection('tokens').doc(cleanToken);
        const directDocSnap = await directDocRef.get();

        if (directDocSnap.exists) {
          targetDoc = directDocSnap;
        } else {
          const querySnap = await db.collection('tokens')
            .where('token', '==', cleanToken)
            .limit(1)
            .get();

          if (!querySnap.empty) {
            targetDoc = querySnap.docs[0];
          }
        }
      } catch (dbErr) {
        console.error("Firestore Read Warning:", dbErr.message);
      }
    }

    // 2. Token Data Resolution (Existing ya Auto-Recovery)
    if (targetDoc && targetDoc.exists) {
      const data = targetDoc.data();

      // Revoked Check
      if (data.status === 'Revoked') {
        return res.status(400).json({ success: false, error: 'This token has been revoked by admin!' });
      }

      // Expiry Check
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

      // Device Mismatch Check
      const existingBoundFp = data.deviceBound || data.boundFingerprint || null;
      if (existingBoundFp && currentFp !== 'device_bound') {
        if (existingBoundFp !== currentFp) {
          return res.status(403).json({ 
            success: false, 
            error: 'Device Mismatch! This key is locked to another device.' 
          });
        }
      }

      // Update Device Lock
      try {
        await targetDoc.ref.update({
          isActivated: true,
          lastVerifiedAt: now,
          deviceBound: existingBoundFp || currentFp,
          boundFingerprint: existingBoundFp || currentFp,
          boundIp: ip
        });
      } catch (upErr) {}

    } else {
      // 3. Fallback: Agar Firestore write pehle miss ho gaya tha par token valid format ka hai
      if (!cleanToken.startsWith('SPIDY-') || cleanToken.length < 15) {
        return res.status(400).json({ success: false, error: 'Invalid Token! Please get a valid key.' });
      }

      // Naya record silently save karein
      if (db) {
        try {
          await db.collection('tokens').doc(cleanToken).set({
            token: cleanToken,
            used: false,
            createdAt: now,
            expiresAt: now + (10 * 24 * 60 * 60 * 1000),
            deviceBound: currentFp,
            boundFingerprint: currentFp,
            boundIp: ip,
            isActivated: true,
            lastVerifiedAt: now,
            source: 'verified_active'
          });
        } catch (setErr) {}
      }
    }

    // 4. Native Set-Cookie Header (Bina kisi external cookie package ke)
    const cookieMaxAge = 10 * 24 * 60 * 60; // 10 Days
    res.setHeader('Set-Cookie', [
      `spidy_auth=verified_${cleanToken}; Path=/; Max-Age=${cookieMaxAge}; SameSite=Lax; HttpOnly; Secure`
    ]);

    return res.status(200).json({ 
      success: true, 
      message: 'Access Granted! Valid for 10 Days.',
      token: cleanToken,
      expiresAt: now + (10 * 24 * 60 * 60 * 1000)
    });

  } catch (error) {
    console.error("Critical Verify Error:", error);
    // Format valid hone par user ko block nahi hone dega
    const rawTok = (req.body && req.body.token) ? String(req.body.token).trim() : '';
    if (rawTok.startsWith('SPIDY-') && rawTok.length >= 15) {
      return res.status(200).json({ 
        success: true, 
        message: 'Access Granted! Valid for 10 Days.',
        token: rawTok,
        expiresAt: Date.now() + (10 * 24 * 60 * 60 * 1000)
      });
    }
    return res.status(400).json({ success: false, error: 'Verification failed. Please try again.' });
  }
};
