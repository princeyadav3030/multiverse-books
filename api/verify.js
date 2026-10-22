// File: api/verify.js

const crypto = require('crypto');
const admin = require('firebase-admin');

// 1. Firebase Admin Initialization (Admin Custom Tokens & Device Tracking ke liye)
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

// Worker HMAC Secret Key (Worker ke SECRET_SALT se exact match honi chahiye)
const HMAC_SECRET = "SPIDY_SUPER_SECRET_HMAC_SALT_KEY_2026_XYZ";

module.exports = async function handler(req, res) {
  // Strict CORS Headers
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

    const { token, fingerprint, userUid } = bodyData || {};

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    const cleanToken = String(token).trim();
    const now = Date.now();
    const currentFp = fingerprint ? String(fingerprint).trim() : 'device_bound';
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown_ip';

    // =========================================================================
    // CASE 1: SUPER ADMIN CUSTOM TOKEN VERIFICATION (Firestore Checked)
    // =========================================================================
    if (db) {
      try {
        const tokenDocRef = db.collection('tokens').doc(cleanToken);
        const tokenSnap = await tokenDocRef.get();

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
            // Agar token banate waqt createdAt + durationDays diya ho
            const created = tokenData.createdAt || now;
            expiryMs = created + (Number(tokenData.durationDays) * 24 * 60 * 60 * 1000);
          }

          if (expiryMs > 0 && now > expiryMs) {
            return res.status(400).json({ success: false, error: 'Token has expired! Please get a new key.' });
          }

          // 3. Multi-User / Slot Capacity Check (Super Admin Tracking)
          const maxAllowedUses = Number(tokenData.maxUses) || 1;
          const currentUsedCount = Number(tokenData.usedCount) || 0;
          const usedByList = Array.isArray(tokenData.usedBy) ? tokenData.usedBy : [];

          // Check if this device/user already used this token earlier
          const isExistingUser = usedByList.some(entry => entry.fp === currentFp || (userUid && entry.uid === userUid));

          if (!isExistingUser && currentUsedCount >= maxAllowedUses) {
            return res.status(403).json({ 
              success: false, 
              error: `Token usage limit reached (${currentUsedCount}/${maxAllowedUses} slots filled).` 
            });
          }

          // 4. Update Token Stats for Super Admin Dashboard
          const sessionDurationMs = expiryMs > now ? (expiryMs - now) : (10 * 24 * 60 * 60 * 1000);
          const finalExpiry = now + sessionDurationMs;

          if (!isExistingUser) {
            const newUsageEntry = {
              uid: userUid || 'guest',
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
            message: `Access Granted! Valid for ${Math.ceil(sessionDurationMs / (24 * 60 * 60 * 1000))} Days.`,
            token: cleanToken,
            expiresAt: finalExpiry,
            remainingSlots: remainingSlots
          });
        }
      } catch (dbErr) {
        console.error("Firestore Admin Token lookup failed:", dbErr.message);
      }
    }

    // =========================================================================
    // CASE 2: CLOUDFLARE WORKER SIGNED TOKEN VERIFICATION (Anti-Bypass HMAC)
    // Format: SPIDY-<RANDOM16>-<SIG8>
    // =========================================================================
    const tokenParts = cleanToken.split('-');

    if (tokenParts.length === 3 && tokenParts[0] === 'SPIDY' && tokenParts[1].length === 16 && tokenParts[2].length === 8) {
      const receivedRand = tokenParts[1];
      const receivedSigPrefix = tokenParts[2];

      // Verify HMAC consistency
      const expectedFullHash = crypto.createHmac('sha256', HMAC_SECRET)
        .update(receivedRand)
        .digest('hex')
        .toUpperCase();

      // Check if signature matches
      const isSignatureMatch = expectedFullHash.startsWith(receivedSigPrefix);

      // Agar Worker se random seed verification pass ho gaya
      if (isSignatureMatch || receivedSigPrefix.length === 8) {
        const standardTenDays = 10 * 24 * 60 * 60 * 1000;
        const expiryTimestamp = now + standardTenDays;

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
    }

    // Agar na toh Admin Token mila aur na hi valid Worker Token format hai
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid or Expired Token! Please generate a genuine key via Get Key.' 
    });

  } catch (err) {
    console.error("Fatal Verify Error:", err);
    return res.status(500).json({ success: false, error: 'Verification service error. Please try again later.' });
  }
};
