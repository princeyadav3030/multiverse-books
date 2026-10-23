// File: api/verify.js

const crypto = require('crypto');
const admin = require('firebase-admin');

// 1. Firebase Admin Initialization (Server-Side Secure)
function getCleanPrivateKey() {
  let key = process.env.FIREBASE_PRIVATE_KEY || "";
  if (!key) return undefined;
  key = key.trim().replace(/^["']|["']$/g, '');
  if (key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n');
  }
  return key;
}

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: getCleanPrivateKey(),
      }),
    });
  } catch (e) {
    console.warn("Firebase Admin Init Warning in verify.js:", e.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;

module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    let bodyData = req.body;
    if (typeof bodyData === 'string') {
      try {
        bodyData = JSON.parse(bodyData);
      } catch (err) {
        return res.status(400).json({ success: false, error: 'Invalid JSON request payload' });
      }
    }

    const { token, fingerprint, userUid, userEmail } = bodyData || {};

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    // Mandatory Login Check (Bina account binding ke verify nahi hoga)
    if (!userUid) {
      return res.status(401).json({ success: false, error: 'Please login to verify your key.' });
    }

    const cleanToken = String(token).trim().toUpperCase();
    const now = Date.now();
    const currentFp = fingerprint ? String(fingerprint).trim() : 'device_bound';
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown_ip';

    if (!db) {
      return res.status(500).json({ success: false, error: 'Database service unavailable' });
    }

    const tokenDocRef = db.collection('tokens').doc(cleanToken);
    const tokenSnap = await tokenDocRef.get();

    // =========================================================================
    // CASE 1: TOKEN PEHLE SE DATABASE ME EXIST KARTA HAI (Already Claimed / Admin Token)
    // =========================================================================
    if (tokenSnap.exists) {
      const tokenData = tokenSnap.data();

      // 1. Status Check
      if (tokenData.status === 'Revoked' || tokenData.status === 'Disabled') {
        return res.status(403).json({ success: false, error: 'This token has been revoked by admin.' });
      }

      // 2. Expiry Check
      let expiryMs = 0;
      if (tokenData.expiresAt && typeof tokenData.expiresAt.toMillis === 'function') {
        expiryMs = tokenData.expiresAt.toMillis();
      } else if (typeof tokenData.expiresAt === 'number') {
        expiryMs = tokenData.expiresAt;
      } else if (tokenData.durationDays) {
        const created = tokenData.createdAt || now;
        expiryMs = created + (Number(tokenData.durationDays) * 24 * 60 * 60 * 1000);
      }

      if (expiryMs > 0 && now > expiryMs) {
        return res.status(400).json({ success: false, error: 'Token has expired! Please generate a new key.' });
      }

      // 3. A. WORKER AD TOKEN CHECK (Strict 1 Token = 1 Account & 1 Device)
      if (tokenData.type === 'worker_ad_token' || cleanToken.startsWith('SPIDY-')) {
        // Dusre account se verify karne par seedha REJECT!
        if (tokenData.boundUid && tokenData.boundUid !== userUid) {
          return res.status(403).json({ 
            success: false, 
            error: 'Security Alert: This key is already claimed by another account and cannot be transferred!' 
          });
        }

        // Agar same account hai, par doosre phone par dala gaya
        if (tokenData.boundFp && tokenData.boundFp !== currentFp) {
          return res.status(403).json({ 
            success: false, 
            error: 'This key is bound to another device. Please get a fresh key for this device.' 
          });
        }

        // Same user usi device par dobara verify kar raha hai (Restore Access)
        const remainingTimeMs = expiryMs > now ? (expiryMs - now) : 0;
        const remainingDays = Math.max(1, Math.ceil(remainingTimeMs / (24 * 60 * 60 * 1000)));

        res.setHeader('Set-Cookie', [
          `spidy_auth=verified_${cleanToken}; Path=/; Max-Age=${Math.floor(remainingTimeMs / 1000)}; SameSite=Lax; HttpOnly; Secure`
        ]);

        return res.status(200).json({
          success: true,
          message: `Access Restored! Valid for remaining ${remainingDays} Days.`,
          token: cleanToken,
          expiresAt: expiryMs
        });
      }

      // 3. B. SUPER ADMIN CUSTOM TOKEN (Multi-User Slots Tracking)
      const maxAllowedUses = Number(tokenData.maxUses) || 1;
      const currentUsedCount = Number(tokenData.usedCount) || 0;
      const usedByList = Array.isArray(tokenData.usedBy) ? tokenData.usedBy : [];

      const isExistingUser = usedByList.some(entry => entry.uid === userUid || entry.fp === currentFp);

      if (!isExistingUser && currentUsedCount >= maxAllowedUses) {
        return res.status(403).json({ 
          success: false, 
          error: `Token usage limit reached (${currentUsedCount}/${maxAllowedUses} slots already used).` 
        });
      }

      const sessionDurationMs = expiryMs > now ? (expiryMs - now) : (10 * 24 * 60 * 60 * 1000);
      const finalExpiry = now + sessionDurationMs;

      if (!isExistingUser) {
        const newUsageEntry = {
          uid: userUid,
          email: userEmail || "unknown",
          fp: currentFp,
          ip: clientIp,
          verifiedAt: now
        };

        await tokenDocRef.update({
          usedCount: admin.firestore.FieldValue.increment(1),
          usedBy: admin.firestore.FieldValue.arrayUnion(newUsageEntry),
          lastVerifiedAt: now,
          isActivated: true
        });
      }

      const cookieMaxAge = Math.floor(sessionDurationMs / 1000);
      res.setHeader('Set-Cookie', [
        `spidy_auth=verified_${cleanToken}; Path=/; Max-Age=${cookieMaxAge}; SameSite=Lax; HttpOnly; Secure`
      ]);

      const remainingSlots = Math.max(0, maxAllowedUses - (isExistingUser ? currentUsedCount : currentUsedCount + 1));

      return res.status(200).json({
        success: true,
        message: `Admin Access Granted! Valid for ${Math.ceil(sessionDurationMs / (24 * 60 * 60 * 1000))} Days.`,
        token: cleanToken,
        expiresAt: finalExpiry,
        remainingSlots: remainingSlots
      });
    }

    // =========================================================================
    // CASE 2: NAYA WORKER SIGNED TOKEN (First Time Verification & Iron Lock)
    // Format: SPIDY-<RANDOM16>-<SIG8> (e.g. SPIDY-7FCA27D54C1B4475-74A25A4B)
    // =========================================================================
    const tokenParts = cleanToken.split('-');

    // Strict Format Validation (Exact 3 parts: SPIDY, 16 hex, 8 hex)
    const isValidFormat = (
      tokenParts.length === 3 && 
      tokenParts[0] === 'SPIDY' && 
      tokenParts[1].length === 16 && 
      /^[0-9A-F]{16}$/i.test(tokenParts[1]) &&
      tokenParts[2].length === 8 &&
      /^[0-9A-F]{8}$/i.test(tokenParts[2])
    );

    if (isValidFormat) {
      // 10 Days Access Duration
      const standardTenDays = 10 * 24 * 60 * 60 * 1000;
      const expiryTimestamp = now + standardTenDays;

      // DATABASE LOCK: Pehli baar aate hi token ko is User UID aur Device ke sath lock kar do!
      await tokenDocRef.set({
        token: cleanToken,
        boundUid: userUid,
        boundEmail: userEmail || "",
        boundFp: currentFp,
        firstVerifiedIp: clientIp,
        createdAt: now,
        expiresAt: expiryTimestamp,
        durationDays: 10,
        status: 'Active',
        type: 'worker_ad_token'
      });

      res.setHeader('Set-Cookie', [
        `spidy_auth=verified_${cleanToken}; Path=/; Max-Age=${10 * 24 * 60 * 60}; SameSite=Lax; HttpOnly; Secure`
      ]);

      return res.status(200).json({
        success: true,
        message: 'Access Granted! Valid for 10 Days.',
        token: cleanToken,
        expiresAt: expiryTimestamp
      });
    }

    // Agar na format valid hai aur na database me mila
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid or Expired Token! Please generate a fresh key via Get Key.' 
    });

  } catch (err) {
    console.error("Fatal Verify Error:", err);
    return res.status(500).json({ success: false, error: 'Verification service error. Please try again.' });
  }
};
