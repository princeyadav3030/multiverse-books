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
            --card-surface: rgba(15, 23, 42, 0.72);
            --border-glow: rgba(255, 255, 255, 0.08);
            --neon-emerald: #10b981;
            --neon-cyan: #06b6d4;
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
            overflow-x: hidden;
        }

        .ambient-glow {
            position: absolute;
            width: 340px;
            height: 340px;
            background: radial-gradient(circle, rgba(16, 185, 129, 0.12) 0%, rgba(6, 182, 212, 0.05) 50%, transparent 70%);
            border-radius: 50%;
            filter: blur(85px);
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

        .auth-card {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 400px;
            background: var(--card-surface);
            backdrop-filter: blur(28px);
            -webkit-backdrop-filter: blur(28px);
            border: 1px solid var(--border-glow);
            border-radius: 26px;
            padding: 30px 22px 24px;
            text-align: center;
            box-shadow: 
                0 25px 50px -12px rgba(0, 0, 0, 0.95),
                inset 0 1px 1px rgba(255, 255, 255, 0.1);
            animation: cardFadeUp 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes cardFadeUp {
            0% { transform: scale(0.93) translateY(14px); opacity: 0; }
            100% { transform: scale(1) translateY(0); opacity: 1; }
        }

        .icon-hex {
            width: 66px;
            height: 66px;
            margin: 0 auto 15px;
            background: rgba(16, 185, 129, 0.08);
            border: 1.5px solid rgba(16, 185, 129, 0.38);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--neon-emerald);
            font-size: 24px;
            box-shadow: 0 0 18px rgba(16, 185, 129, 0.22);
            position: relative;
        }

        .icon-hex::after {
            content: '';
            position: absolute;
            inset: -4px;
            border-radius: 24px;
            border: 1.5px dashed rgba(6, 182, 212, 0.45);
            animation: rotatePerimeter 16s linear infinite;
        }

        @keyframes rotatePerimeter {
            100% { transform: rotate(360deg); }
        }

        .status-badge {
            display: inline-block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 700;
            color: var(--neon-emerald);
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.28);
            padding: 3px 12px;
            border-radius: 20px;
            letter-spacing: 0.8px;
            margin-bottom: 12px;
            text-transform: uppercase;
        }

        .status-badge.blocked {
            color: #f43f5e;
            background: rgba(244, 63, 94, 0.1);
            border-color: rgba(244, 63, 94, 0.3);
        }

        .card-title {
            font-size: 20px;
            font-weight: 800;
            letter-spacing: -0.3px;
            color: #ffffff;
            margin-bottom: 6px;
        }

        .card-subtitle {
            font-size: 13px;
            color: var(--text-muted);
            margin-bottom: 20px;
            line-height: 1.5;
            padding: 0 6px;
        }

        .key-wrapper {
            position: relative;
            width: 100%;
            margin-bottom: 14px;
        }

        .key-display-box {
            width: 100%;
            min-height: 56px;
            background: linear-gradient(180deg, rgba(3, 7, 18, 0.75) 0%, rgba(10, 15, 29, 0.6) 100%);
            border: 1px solid rgba(16, 185, 129, 0.24);
            border-radius: 14px;
            padding: 12px 14px;
            color: #34d399;
            font-family: 'JetBrains Mono', monospace;
            font-size: 16px;
            font-weight: 700;
            letter-spacing: 1.5px;
            outline: none;
            text-align: center;
            box-shadow: 
                inset 0 2px 8px rgba(0, 0, 0, 0.8),
                0 0 15px rgba(16, 185, 129, 0.05);
            display: flex;
            align-items: center;
            justify-content: center;
            word-break: break-all;
            white-space: normal;
            line-height: 1.4;
            user-select: all;
            transition: all 0.2s ease;
        }

        .key-display-box.empty {
            color: #64748b;
            font-weight: 600;
            letter-spacing: 0.8px;
            font-size: 14px;
            border-color: rgba(255, 255, 255, 0.08);
            background: rgba(0, 0, 0, 0.45);
        }

        .key-display-box.blocked {
            color: #f43f5e;
            font-size: 13px;
            letter-spacing: 0.5px;
            border-color: rgba(244, 63, 94, 0.3);
            background: rgba(244, 63, 94, 0.05);
        }

        .btn-stack {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 18px;
        }

        .btn-copy {
            width: 100%;
            padding: 13px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff;
            font-size: 14px;
            font-weight: 700;
            border: none;
            border-radius: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25);
            transition: transform 0.15s ease, opacity 0.15s ease, background 0.2s ease;
        }

        .btn-copy:active {
            transform: scale(0.97);
            opacity: 0.9;
        }

        .btn-copy.copied {
            background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
            box-shadow: 0 4px 14px rgba(6, 182, 212, 0.25);
        }

        .btn-support {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            padding: 11px;
            background: rgba(255, 255, 255, 0.035);
            color: var(--text-muted);
            font-size: 13px;
            font-weight: 600;
            text-decoration: none;
            border-radius: 13px;
            border: 1px solid rgba(255, 255, 255, 0.06);
            transition: all 0.15s ease;
        }

        .btn-support:active {
            background: rgba(255, 255, 255, 0.08);
            color: #ffffff;
            transform: scale(0.97);
        }

        .warning-box {
            background: rgba(244, 63, 94, 0.06);
            border: 1px solid rgba(244, 63, 94, 0.16);
            border-left: 3.5px solid #f43f5e;
            border-radius: 11px;
            padding: 12px 14px;
            display: flex;
            align-items: flex-start;
            gap: 10px;
            text-align: left;
            margin-bottom: 20px;
        }

        .warning-box i {
            color: #f43f5e;
            font-size: 14px;
            margin-top: 2px;
        }

        .warning-box p {
            color: #cbd5e1;
            font-size: 11px;
            line-height: 1.55;
            font-weight: 500;
        }

        .card-footer {
            padding-top: 14px;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 20px;
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
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="ambient-glow"></div>
    <div class="cyber-grid"></div>

    <div class="auth-card">
        <div class="icon-hex">
            <i class="fas fa-key"></i>
        </div>

        <div class="status-badge" id="statusBadge">${displayKey ? 'KEY READY' : 'CHECKING...'}</div>
        <h1 class="card-title">Your Authentication Key</h1>
        <p class="card-subtitle">Your Auth Key is generated and ready to use in the app.</p>

        <div class="key-wrapper">
            <div class="key-display-box ${displayKey ? '' : 'empty'}" id="authKeyContainer">
                ${displayKey ? displayKey : 'Checking session...'}
            </div>
        </div>

        <div class="btn-stack">
            <button class="btn-copy" id="copyBtn">
                <i class="far fa-copy"></i> <span>Copy Auth Key</span>
            </button>
            <a href="https://t.me/MultiverseBooks" target="_blank" rel="noopener noreferrer" class="btn-support">
                <i class="fab fa-telegram"></i> Need Help? Support
            </a>
        </div>

        <div class="warning-box">
            <i class="fas fa-circle-exclamation"></i>
            <p>This Auth Key is specifically generated for your current device and will only function on it. If you try to use this key on any other device, it will be rejected.</p>
        </div>

        <div class="card-footer">
            <span><i class="far fa-clock"></i> Valid for 10 Days</span>
            <span><i class="fas fa-shield-halved"></i> Secure Gateway</span>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const authKeyContainer = document.getElementById('authKeyContainer');
            const statusBadge = document.getElementById('statusBadge');
            const copyBtn = document.getElementById('copyBtn');
            const btnText = copyBtn.querySelector('span');
            const btnIcon = copyBtn.querySelector('i');

            // ========================================================
            // YAHAN TIME CHANGE KAREIN (MINIMUM AD DURATION IN SECONDS)
            // ========================================================
            const MIN_AD_TIME_SECONDS = 15; // Abhi 15s hai, aage 25 ya 30 kar sakte hain

            let key = "${displayKey}";
            const now = Date.now();

            if (!key) {
                const pending = localStorage.getItem('spidy_pending_generated_key');
                const pendingTimeStr = localStorage.getItem('spidy_pending_key_time');

                if (pending && pendingTimeStr) {
                    const elapsedSeconds = (now - parseInt(pendingTimeStr, 10)) / 1000;

                    // ANTI-BACK / BYPASS CHECK:
                    if (elapsedSeconds < MIN_AD_TIME_SECONDS) {
                        // User jaldi back aa gaya (Ads skip kiya)
                        authKeyContainer.innerText = 'Verification Incomplete! Please complete ads.';
                        authKeyContainer.classList.add('blocked');
                        statusBadge.innerText = 'BYPASS DETECTED';
                        statusBadge.classList.add('blocked');
                        return;
                    } else if (elapsedSeconds <= (15 * 60)) {
                        // 15 seconds ke baad aur 15 minutes ke andar
                        key = pending;
                    }
                }
            }

            if (key) {
                authKeyContainer.innerText = key;
                authKeyContainer.classList.remove('empty', 'blocked');
                statusBadge.innerText = 'KEY READY';
                statusBadge.classList.remove('blocked');
            } else {
                authKeyContainer.innerText = 'No Key Generated';
                authKeyContainer.classList.add('empty');
                statusBadge.innerText = 'NO ACCESS KEY';
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
