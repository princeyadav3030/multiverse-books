// File: api/generate.js

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  const incomingCode = req.query.code || req.query.key || '';
  const displayKey = incomingCode ? String(incomingCode).trim() : '';

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Spidy Book Hub - Auth Key</title>
    <!-- Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
    <!-- Icons -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    
    <style>
        :root {
            --bg-base: #060709;
            --card-surface: rgba(16, 18, 27, 0.88);
            --border-glow: rgba(16, 185, 129, 0.22);
            --neon-emerald: #10b981;
            --neon-cyan: #06b6d4;
            --neon-blue: #3b82f6;
            --neon-purple: #8b5cf6;
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
            padding: 14px;
            position: relative;
            overflow: hidden;
        }

        .ambient-glow {
            position: absolute;
            width: 320px;
            height: 320px;
            background: radial-gradient(circle, rgba(16, 185, 129, 0.12) 0%, rgba(6, 182, 212, 0.04) 50%, transparent 70%);
            border-radius: 50%;
            filter: blur(80px);
            pointer-events: none;
            z-index: 0;
        }

        .cyber-grid {
            position: absolute;
            inset: 0;
            background-image: 
                linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
            background-size: 28px 28px;
            mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
            -webkit-mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
            pointer-events: none;
            z-index: 0;
        }

        /* Compact, Highly Focused Frame */
        .auth-card {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 375px;
            background: var(--card-surface);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid var(--border-glow);
            border-radius: 26px;
            padding: 24px 20px 18px;
            text-align: center;
            box-shadow: 
                0 25px 50px -12px rgba(0, 0, 0, 0.95),
                0 0 25px rgba(16, 185, 129, 0.06),
                inset 0 1px 1px rgba(255, 255, 255, 0.1);
            animation: cardFadeUp 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes cardFadeUp {
            0% { transform: scale(0.94) translateY(12px); opacity: 0; }
            100% { transform: scale(1) translateY(0); opacity: 1; }
        }

        /* Rotating Hexagon Icon */
        .icon-hex {
            width: 60px;
            height: 60px;
            margin: 0 auto 14px;
            background: rgba(16, 185, 129, 0.09);
            border: 1.5px solid rgba(16, 185, 129, 0.4);
            border-radius: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--neon-emerald);
            font-size: 22px;
            box-shadow: 0 0 18px rgba(16, 185, 129, 0.22);
            position: relative;
        }

        .icon-hex::after {
            content: '';
            position: absolute;
            inset: -4px;
            border-radius: 22px;
            border: 1.5px dashed rgba(6, 182, 212, 0.45);
            animation: rotatePerimeter 16s linear infinite;
        }

        @keyframes rotatePerimeter {
            100% { transform: rotate(360deg); }
        }

        .card-title {
            font-size: 19px;
            font-weight: 800;
            letter-spacing: -0.3px;
            color: #ffffff;
            margin-bottom: 5px;
        }

        .card-subtitle {
            font-size: 12px;
            color: var(--text-muted);
            margin-bottom: 16px;
            line-height: 1.4;
        }

        /* Attractive, Bounded Key Console Box */
        .key-wrapper {
            position: relative;
            width: 100%;
            margin-bottom: 13px;
        }

        .key-display-box {
            width: 100%;
            min-height: 48px;
            background: linear-gradient(180deg, rgba(6, 9, 16, 0.9) 0%, rgba(10, 15, 27, 0.75) 100%);
            border: 1px solid rgba(16, 185, 129, 0.26);
            border-radius: 13px;
            padding: 10px 12px;
            color: #34d399;
            font-family: 'JetBrains Mono', monospace;
            font-size: 15px;
            font-weight: 700;
            letter-spacing: 1.2px;
            outline: none;
            text-align: center;
            box-shadow: 
                inset 0 2px 6px rgba(0, 0, 0, 0.85),
                0 0 14px rgba(16, 185, 129, 0.05);
            display: flex;
            align-items: center;
            justify-content: center;
            word-break: break-all;
            white-space: normal;
            line-height: 1.35;
            user-select: all;
            transition: all 0.2s ease;
        }

        .key-display-box.empty {
            color: #64748b;
            font-size: 13px;
            border-color: rgba(255, 255, 255, 0.08);
            background: rgba(0, 0, 0, 0.45);
        }

        .key-display-box.blocked {
            color: #ef4444;
            font-size: 12px;
            border-color: rgba(239, 68, 68, 0.3);
            background: rgba(239, 68, 68, 0.06);
        }

        /* Buttons Stack with Cohesive Colors */
        .btn-stack {
            display: flex;
            flex-direction: column;
            gap: 9px;
            margin-bottom: 15px;
        }

        /* 1. Copy Key - Neon Emerald */
        .btn-copy {
            width: 100%;
            padding: 12px 14px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff;
            font-size: 13.5px;
            font-weight: 700;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25);
            transition: transform 0.15s ease, opacity 0.15s ease;
        }

        .btn-copy:active {
            transform: scale(0.97);
            opacity: 0.9;
        }

        .btn-copy.copied {
            background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
            box-shadow: 0 4px 14px rgba(6, 182, 212, 0.3);
        }

        /* 2. Homepage - Electric Blue */
        .btn-home {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            padding: 12px 14px;
            background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
            color: #ffffff;
            font-size: 13.5px;
            font-weight: 700;
            text-decoration: none;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 14px rgba(37, 99, 235, 0.25);
            transition: transform 0.15s ease, opacity 0.15s ease;
        }

        .btn-home:active {
            transform: scale(0.97);
            opacity: 0.9;
        }

        /* 3. Support - Cyber Purple Gradient */
        .btn-support {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            padding: 11px 14px;
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.18) 0%, rgba(99, 102, 241, 0.14) 100%);
            color: #c4b5fd;
            font-size: 13px;
            font-weight: 600;
            text-decoration: none;
            border-radius: 12px;
            border: 1px solid rgba(139, 92, 246, 0.3);
            box-shadow: 0 4px 12px rgba(139, 92, 246, 0.12);
            transition: all 0.15s ease;
        }

        .btn-support i {
            color: #a78bfa;
            font-size: 14px;
        }

        .btn-support:active {
            background: rgba(139, 92, 246, 0.28);
            color: #ffffff;
            transform: scale(0.97);
        }

        /* Advisory Strip */
        .advisory-strip {
            background: rgba(239, 68, 68, 0.06);
            border: 1px solid rgba(239, 68, 68, 0.18);
            border-left: 3px solid #ef4444;
            border-radius: 10px;
            padding: 10px 12px;
            display: flex;
            align-items: flex-start;
            gap: 9px;
            text-align: left;
            margin-bottom: 15px;
        }

        .advisory-strip i {
            color: #ef4444;
            font-size: 13px;
            margin-top: 2px;
        }

        .advisory-strip p {
            color: #cbd5e1;
            font-size: 11px;
            line-height: 1.45;
            font-weight: 500;
        }

        /* Footer Aligned to Left and Right Corners */
        .card-footer {
            padding-top: 13px;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            display: flex;
            align-items: center;
            justify-content: space-between; /* Left and Right Spacing */
            padding-left: 4px;
            padding-right: 4px;
            font-size: 11px;
            color: #64748b;
            font-weight: 600;
            letter-spacing: 0.3px;
        }

        .card-footer span {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .card-footer i {
            color: var(--neon-emerald);
            font-size: 11px;
        }
    </style>
</head>
<body>
    <div class="ambient-glow"></div>
    <div class="cyber-grid"></div>

    <div class="auth-card">
        <!-- Rotating Hexagon Logo -->
        <div class="icon-hex">
            <i class="fas fa-key"></i>
        </div>

        <h1 class="card-title">Your Authentication Key</h1>
        <p class="card-subtitle">Your Auth Key is generated and ready to use in the app.</p>

        <!-- Key Console Box -->
        <div class="key-wrapper">
            <div class="key-display-box ${displayKey ? '' : 'empty'}" id="authKeyContainer">
                ${displayKey ? displayKey : 'Checking session...'}
            </div>
        </div>

        <!-- Buttons Stack -->
        <div class="btn-stack">
            <button class="btn-copy" id="copyBtn">
                <i class="far fa-copy"></i> <span>Copy Auth Key</span>
            </button>
            <a href="/" class="btn-home">
                <i class="fas fa-house"></i> Go to Homepage
            </a>
            <a href="https://t.me/MultiverseBooks" target="_blank" rel="noopener noreferrer" class="btn-support">
                <i class="fab fa-telegram"></i> Need Help? Support
            </a>
        </div>

        <!-- Device Advisory -->
        <div class="advisory-strip">
            <i class="fas fa-shield-halved"></i>
            <p>This key binds to your device on first verification and cannot be transferred or shared.</p>
        </div>

        <!-- Left & Right Aligned Footer -->
        <div class="card-footer">
            <span><i class="far fa-clock"></i> Valid for 10 Days</span>
            <span><i class="fas fa-lock"></i> Secure Gateway</span>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const authKeyContainer = document.getElementById('authKeyContainer');
            const copyBtn = document.getElementById('copyBtn');
            const btnText = copyBtn.querySelector('span');
            const btnIcon = copyBtn.querySelector('i');

            const MIN_AD_TIME_SECONDS = 15;

            let key = "${displayKey}";
            const now = Date.now();

            if (!key) {
                const pending = localStorage.getItem('spidy_pending_generated_key');
                const pendingTimeStr = localStorage.getItem('spidy_pending_key_time');

                if (pending && pendingTimeStr) {
                    const elapsedSeconds = (now - parseInt(pendingTimeStr, 10)) / 1000;

                    if (elapsedSeconds < MIN_AD_TIME_SECONDS) {
                        authKeyContainer.innerText = 'Verification Incomplete! Please complete ads.';
                        authKeyContainer.classList.add('blocked');
                        return;
                    } else if (elapsedSeconds <= (15 * 60)) {
                        key = pending;
                    }
                }
            }

            if (key) {
                authKeyContainer.innerText = key;
                authKeyContainer.classList.remove('empty', 'blocked');
            } else {
                authKeyContainer.innerText = 'No Key Generated';
                authKeyContainer.classList.add('empty');
            }

            copyBtn.addEventListener('click', () => {
                const rawKey = authKeyContainer.innerText.trim();

                if (!rawKey || rawKey === 'No Key Generated' || rawKey.includes('Incomplete') || rawKey === 'Checking session...') {
                    btnText.innerText = 'No Key to Copy!';
                    setTimeout(() => { btnText.innerText = 'Copy Auth Key'; }, 2000);
                    return;
                }

                navigator.clipboard.writeText(rawKey).then(() => {
                    copyBtn.classList.add('copied');
                    btnIcon.className = 'fas fa-check';
                    btnText.innerText = 'Copied Successfully!';
                    
                    setTimeout(() => {
                        copyBtn.classList.remove('copied');
                        btnIcon.className = 'far fa-copy';
                        btnText.innerText = 'Copy Auth Key';
                    }, 3000);
                }).catch(() => {
                    btnText.innerText = 'Failed to copy';
                });
            });
        });
    </script>
</body>
</html>
  `);
};
