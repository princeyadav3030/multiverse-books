const { db } = require('../utils/firebaseAdmin');
const { v4: uuidv4 } = require('uuid');

module.exports = async function handler(req, res) {
  // ==========================================
  // 1. BACKEND TOKEN CLAIM ENGINE (POST)
  // ==========================================
  if (req.method === 'POST') {
    try {
      const { sessionId, fingerprint } = req.body || {};
      const now = Date.now();

      if (!sessionId) {
        return res.status(400).json({ 
          success: false, 
          error: "Session ID missing. Please click 'Get Key' from the website." 
        });
      }

      const sessionDocRef = db.collection('pending_sessions').doc(sessionId);
      const sessionSnap = await sessionDocRef.get();

      if (!sessionSnap.exists) {
        return res.status(403).json({ 
          success: false, 
          error: "Invalid Session: Session not found or expired." 
        });
      }

      const data = sessionSnap.data();

      // Check 1: Single-use burn (Dobara use na ho)
      if (data.consumed) {
        return res.status(403).json({ 
          success: false, 
          error: "Link Expired: This session has already been used." 
        });
      }

      // Check 2: Expiration check (15 mins)
      if (now > data.expiresAt) {
        return res.status(403).json({ 
          success: false, 
          error: "Session Timed Out: Please click 'Get Key' again." 
        });
      }

      // Check 3: Anti-Fast Bypass (Kam se kam 10 seconds ads time)
      if (now < data.unlocksAt) {
        return res.status(403).json({ 
          success: false, 
          error: "Bypass Detected: Ad verification steps completed suspiciously fast." 
        });
      }

      // Session turant consume mark karein
      await sessionDocRef.update({
        consumed: true,
        consumedAt: now
      });

      // 10 Days Token Generate karein
      const token = 'SPIDY-' + uuidv4().substring(0, 8).toUpperCase();
      const expiresAt = now + (10 * 24 * 60 * 60 * 1000);

      await db.collection('tokens').doc(token).set({
        token: token,
        used: false,
        createdAt: now,
        expiresAt: expiresAt,
        deviceBound: fingerprint || null,
        isActivated: false,
        source: 'shortlink_verified',
        boundSession: sessionId
      });

      return res.status(200).json({
        success: true,
        token: token
      });

    } catch (err) {
      console.error("Token Generation Error:", err);
      return res.status(500).json({ 
        success: false, 
        error: "Server Error: Could not issue access token." 
      });
    }
  }

  // ==========================================
  // 2. CLIENT VERIFICATION GATEWAY (GET)
  // ==========================================
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Verifying Key | SPIDY BOOK HUB</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
        
        <style>
          :root {
            --bg-base: #060709;
            --card-surface: rgba(18, 20, 29, 0.85);
            --border-glow: rgba(59, 130, 246, 0.3);
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
            background: radial-gradient(circle, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.02) 55%, transparent 70%);
            border-radius: 50%;
            filter: blur(75px);
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
            padding: 34px 22px 28px;
            text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.95);
          }

          .icon-hex {
            width: 68px;
            height: 68px;
            margin: 0 auto 18px;
            background: rgba(59, 130, 246, 0.1);
            border: 1.5px solid rgba(59, 130, 246, 0.4);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #3b82f6;
            font-size: 28px;
          }

          .icon-hex.error {
            background: rgba(239, 68, 68, 0.1);
            border-color: rgba(239, 68, 68, 0.4);
            color: #ef4444;
          }

          .status-badge {
            display: inline-block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 700;
            color: #3b82f6;
            background: rgba(59, 130, 246, 0.12);
            border: 1px solid rgba(59, 130, 246, 0.3);
            padding: 4px 14px;
            border-radius: 20px;
            letter-spacing: 0.8px;
            margin-bottom: 14px;
            text-transform: uppercase;
          }

          .status-badge.error {
            color: #ef4444;
            background: rgba(239, 68, 68, 0.12);
            border-color: rgba(239, 68, 68, 0.3);
          }

          .card-title {
            font-size: 20px;
            font-weight: 800;
            margin-bottom: 10px;
          }

          .card-desc {
            font-size: 13px;
            line-height: 1.55;
            color: var(--text-muted);
            margin-bottom: 24px;
          }

          .btn-home {
            display: none;
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
          }
        </style>
      </head>
      <body>
        <div class="ambient-glow"></div>

        <div class="security-card">
          <div class="icon-hex" id="statusIcon">
            <i class="fas fa-circle-notch fa-spin"></i>
          </div>

          <div class="status-badge" id="statusBadge">Verifying Handshake</div>
          <h1 class="card-title" id="statusTitle">Validating Ads Flow...</h1>

          <p class="card-desc" id="statusDesc">
            Please wait a moment while we verify your session and unlock your 10-day key.
          </p>

          <a href="/" class="btn-home" id="homeBtn">
            <i class="fas fa-house"></i> Go to Homepage
          </a>
        </div>

        <script>
          async function executeHandshake() {
            // URL se session pakdo agar ho, nahi to localStorage se lo
            const urlParams = new URLSearchParams(window.location.search);
            let sessionId = urlParams.get('session') || urlParams.get('sid');

            if (!sessionId) {
              sessionId = localStorage.getItem('spidy_active_session_id');
            }

            const fp = localStorage.getItem('spidy_device_fp') || 'unknown';

            if (!sessionId) {
              displayFailure("Direct generation blocked. Please click 'Get Key' from the website first.");
              return;
            }

            try {
              const res = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sessionId, fingerprint: fp })
              });

              const data = await res.json();

              if (res.ok && data.success && data.token) {
                // Verification complete: storage clean karein
                localStorage.removeItem('spidy_active_session_id');

                document.getElementById('statusTitle').innerText = "Access Granted!";
                document.getElementById('statusDesc').innerText = "Redirecting to book hub with your active key...";

                setTimeout(() => {
                  window.location.replace('/?t=' + encodeURIComponent(data.token));
                }, 600);
              } else {
                displayFailure(data.error || "Ad flow was not completed properly.");
              }
            } catch (err) {
              displayFailure("Network error. Could not connect to verification gateway.");
            }
          }

          function displayFailure(msg) {
            const icon = document.getElementById('statusIcon');
            const badge = document.getElementById('statusBadge');
            const title = document.getElementById('statusTitle');
            const desc = document.getElementById('statusDesc');
            const btn = document.getElementById('homeBtn');

            icon.className = "icon-hex error";
            icon.innerHTML = '<i class="fas fa-shield-halved"></i>';

            badge.className = "status-badge error";
            badge.innerText = "403 • Unauthorized Access";

            title.innerText = "Direct Generation Blocked";
            desc.innerHTML = msg + "<br><br>Please click <b>'Get Key'</b> on the website and complete verification properly.";

            btn.style.display = "flex";
          }

          window.addEventListener('DOMContentLoaded', executeHandshake);
        </script>
      </body>
      </html>
    `);
  }

  return res.status(405).send('Method Not Allowed');
};
