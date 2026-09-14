const { db } = require('../utils/firebaseAdmin');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  const { session, sig, ts } = req.query;
  const referer = (req.headers['referer'] || req.headers['referrer'] || '').toLowerCase();
  const SECRET = process.env.SHORTLINK_AUTH_SECRET || "SPIDY_BYPASS_SHIELD_99";

  // Validate Handshake Parameters
  let isValidHandshake = false;

  if (session && sig && ts) {
    const timeDiff = Date.now() - Number(ts);
    // 10 minutes (600,000 ms) expiry window
    if (timeDiff >= 0 && timeDiff <= 600000) {
      const expectedSig = crypto
        .createHmac('sha256', SECRET)
        .update(`${session}_${ts}`)
        .digest('hex');

      if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
        isValidHandshake = true;
      }
    }
  }

  // Allow verified handshake OR valid shortener referrer
  const isAuthorizedAccess = isValidHandshake || 
    referer.includes('arolinks') || 
    referer.includes('droplink');

  if (!isAuthorizedAccess) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Access Restricted | SPIDY BOOK HUB</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
        
        <style>
          :root {
            --bg-base: #060709;
            --card-surface: rgba(18, 20, 29, 0.85);
            --border-glow: rgba(239, 68, 68, 0.28);
            --danger-red: #ef4444;
            --danger-glow: rgba(239, 68, 68, 0.35);
            --text-main: #ffffff;
            --text-muted: #94a3b8;
          }

          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Plus Jakarta Sans', sans-serif;
            -webkit-tap-highlight-color: transparent;
          }

          body {
            background-color: var(--bg-base);
            color: var(--text-main);
            min-height: 100vh;
            min-height: 100dvh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            position: relative;
            overflow: hidden;
          }

          .ambient-glow {
            position: absolute;
            width: 360px;
            height: 360px;
            background: radial-gradient(circle, rgba(239, 68, 68, 0.15) 0%, rgba(239, 68, 68, 0.02) 55%, transparent 70%);
            border-radius: 50%;
            filter: blur(75px);
            pointer-events: none;
            z-index: 0;
          }

          .cyber-grid {
            position: absolute;
            inset: 0;
            background-image: 
              linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
            background-size: 28px 28px;
            mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
            -webkit-mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
            pointer-events: none;
            z-index: 0;
          }

          .security-card {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 390px;
            background: var(--card-surface);
            backdrop-filter: blur(25px);
            -webkit-backdrop-filter: blur(25px);
            border: 1px solid var(--border-glow);
            border-radius: 26px;
            padding: 32px 22px 26px;
            text-align: center;
            box-shadow: 
              0 25px 50px -12px rgba(0, 0, 0, 0.95),
              0 0 30px rgba(239, 68, 68, 0.1),
              inset 0 1px 1px rgba(255, 255, 255, 0.12);
            animation: cardFadeUp 0.35s cubic-bezier(0.16, 1, 0.3, 1);
          }

          @keyframes cardFadeUp {
            0% { transform: scale(0.92) translateY(16px); opacity: 0; }
            100% { transform: scale(1) translateY(0); opacity: 1; }
          }

          .icon-hex {
            width: 68px;
            height: 68px;
            margin: 0 auto 18px;
            background: rgba(239, 68, 68, 0.1);
            border: 1.5px solid rgba(239, 68, 68, 0.4);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--danger-red);
            font-size: 28px;
            box-shadow: 0 0 20px var(--danger-glow);
            position: relative;
          }

          .icon-hex::after {
            content: '';
            position: absolute;
            inset: -4px;
            border-radius: 24px;
            border: 1px dashed rgba(239, 68, 68, 0.45);
            animation: rotatePerimeter 16s linear infinite;
          }

          @keyframes rotatePerimeter {
            100% { transform: rotate(360deg); }
          }

          .error-badge {
            display: inline-block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 700;
            color: var(--danger-red);
            background: rgba(239, 68, 68, 0.12);
            border: 1px solid rgba(239, 68, 68, 0.3);
            padding: 4px 14px;
            border-radius: 20px;
            letter-spacing: 0.8px;
            margin-bottom: 14px;
            text-transform: uppercase;
          }

          .card-title {
            font-size: 20px;
            font-weight: 800;
            letter-spacing: -0.3px;
            color: #ffffff;
            margin-bottom: 10px;
          }

          .card-desc {
            font-size: 13px;
            line-height: 1.55;
            color: var(--text-muted);
            margin-bottom: 24px;
            padding: 0 4px;
          }

          .card-desc span {
            color: #ffffff;
            font-weight: 700;
          }

          .btn-group {
            display: flex;
            flex-direction: column;
            gap: 11px;
          }

          .btn-home {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            width: 100%;
            padding: 14px 18px;
            background: linear-gradient(135deg, #2563eb, #1d4ed8);
            color: #ffffff;
            font-size: 14px;
            font-weight: 700;
            text-decoration: none;
            border-radius: 14px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            box-shadow: 0 8px 24px rgba(37, 99, 235, 0.4);
            transition: transform 0.15s ease, opacity 0.15s ease;
          }

          .btn-home:active {
            transform: scale(0.96);
            opacity: 0.9;
          }

          .btn-support {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            padding: 12px 18px;
            background: rgba(255, 255, 255, 0.04);
            color: var(--text-muted);
            font-size: 13px;
            font-weight: 600;
            text-decoration: none;
            border-radius: 14px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            transition: all 0.15s ease;
          }

          .btn-support:active {
            background: rgba(255, 255, 255, 0.08);
            color: #ffffff;
            transform: scale(0.96);
          }

          .card-footer {
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            font-size: 11px;
            color: #64748b;
            font-weight: 600;
            letter-spacing: 0.3px;
          }

          .card-footer i {
            color: #10b981;
          }
        </style>
      </head>
      <body>
        <div class="ambient-glow"></div>
        <div class="cyber-grid"></div>

        <div class="security-card">
          <div class="icon-hex">
            <i class="fas fa-shield-halved"></i>
          </div>

          <div class="error-badge">403 • Unauthorized Access</div>
          <h1 class="card-title">Direct Generation Blocked</h1>

          <p class="card-desc">
            Directly opening or copying the generator link is prohibited. Please click <span>'Get Key'</span> on the website and complete verification.
          </p>

          <div class="btn-group">
            <a href="/" class="btn-home">
              <i class="fas fa-house"></i> Go to Homepage
            </a>
            <a href="https://t.me/MultiverseBooks" target="_blank" class="btn-support">
              <i class="fab fa-telegram"></i> Need Help? Support
            </a>
          </div>

          <div class="card-footer">
            <i class="fas fa-lock"></i> SPIDY SYSTEM • SECURE GATEWAY
          </div>
        </div>
      </body>
      </html>
    `);
  }

  // Generate Unique Token
  const token = 'SPIDY-' + uuidv4().substring(0, 8).toUpperCase();
  const expiresAt = Date.now() + (10 * 24 * 60 * 60 * 1000); // 10 Days

  try {
    await db.collection('tokens').doc(token).set({
      token: token,
      used: false,
      createdAt: Date.now(),
      expiresAt: expiresAt,
      deviceBound: null,
      isActivated: false,
      source: 'website',
      boundSession: session || 'direct_flow'
    });

    return res.redirect(`/?t=${token}`);
  } catch (err) {
    console.error("Token Generation Error:", err);
    return res.status(500).send("Database Error: Failed to issue token.");
  }
};
