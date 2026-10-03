// File: api/generate.js

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  // URL query parameter se code read karein (?code=XYZ ya ?key=XYZ)
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
            --card-surface: rgba(15, 23, 42, 0.78);
            --border-glow: rgba(16, 185, 129, 0.22);
            --neon-emerald: #10b981;
            --neon-cyan: #06b6d4;
            --glow-color: rgba(16, 185, 129, 0.35);
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

        /* Ambient Cyan/Emerald Glow */
        .ambient-glow {
            position: absolute;
            width: 360px;
            height: 360px;
            background: radial-gradient(circle, rgba(16, 185, 129, 0.18) 0%, rgba(6, 182, 212, 0.08) 50%, transparent 70%);
            border-radius: 50%;
            filter: blur(85px);
            pointer-events: none;
            z-index: 0;
        }

        /* Cyberpunk Grid Background */
        .cyber-grid {
            position: absolute;
            inset: 0;
            background-image: 
                linear-gradient(rgba(255, 255, 255, 0.022) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 255, 255, 0.022) 1px, transparent 1px);
            background-size: 28px 28px;
            mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
            -webkit-mask-image: radial-gradient(circle at center, black 40%, transparent 80%);
            pointer-events: none;
            z-index: 0;
        }

        /* Main Card */
        .auth-card {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 400px;
            background: var(--card-surface);
            backdrop-filter: blur(28px);
            -webkit-backdrop-filter: blur(28px);
            border: 1px solid var(--border-glow);
            border-radius: 28px;
            padding: 32px 22px 24px;
            text-align: center;
            box-shadow: 
                0 25px 50px -12px rgba(0, 0, 0, 0.95),
                0 0 35px rgba(16, 185, 129, 0.08),
                inset 0 1px 1px rgba(255, 255, 255, 0.12);
            animation: cardFadeUp 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes cardFadeUp {
            0% { transform: scale(0.93) translateY(14px); opacity: 0; }
            100% { transform: scale(1) translateY(0); opacity: 1; }
        }

        /* Top Glowing Neon Sweep Line */
        .auth-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 3px;
            background: linear-gradient(90deg, var(--neon-cyan), var(--neon-emerald), #0ea5e9, var(--neon-emerald), var(--neon-cyan));
            background-size: 200% 100%;
            animation: gradient-sweep 3.5s linear infinite;
            border-top-left-radius: 28px;
            border-top-right-radius: 28px;
        }

        @keyframes gradient-sweep {
            0% { background-position: 0% 0; }
            100% { background-position: 200% 0; }
        }

        /* Cyber Hexagon Rotating Icon (Matching Image 2 Design in Emerald) */
        .icon-hex {
            width: 68px;
            height: 68px;
            margin: 0 auto 16px;
            background: rgba(16, 185, 129, 0.1);
            border: 1.5px solid rgba(16, 185, 129, 0.45);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--neon-emerald);
            font-size: 26px;
            box-shadow: 0 0 22px var(--glow-color);
            position: relative;
        }

        .icon-hex::after {
            content: '';
            position: absolute;
            inset: -4px;
            border-radius: 24px;
            border: 1.5px dashed rgba(6, 182, 212, 0.5);
            animation: rotatePerimeter 16s linear infinite;
        }

        @keyframes rotatePerimeter {
            100% { transform: rotate(360deg); }
        }

        /* Status Badge */
        .status-badge {
            display: inline-block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 700;
            color: var(--neon-emerald);
            background: rgba(16, 185, 129, 0.12);
            border: 1px solid rgba(16, 185, 129, 0.32);
            padding: 4px 14px;
            border-radius: 20px;
            letter-spacing: 0.8px;
            margin-bottom: 12px;
            text-transform: uppercase;
        }

        .card-title {
            font-size: 20px;
            font-weight: 800;
            letter-spacing: -0.3px;
            color: #ffffff;
            margin-bottom: 8px;
        }

        .card-subtitle {
            font-size: 13px;
            color: var(--text-muted);
            margin-bottom: 22px;
            line-height: 1.5;
            padding: 0 4px;
        }

        /* Key Input Box (Strictly bounded so long tokens never overflow) */
        .key-wrapper {
            position: relative;
            width: 100%;
            margin-bottom: 14px;
        }

        .key-display-box {
            width: 100%;
            min-height: 58px;
            background: rgba(0, 0, 0, 0.55);
            border: 1px solid rgba(16, 185, 129, 0.28);
            border-radius: 14px;
            padding: 12px 14px;
            color: #34d399;
            font-family: 'JetBrains Mono', monospace;
            font-size: 16px;
            font-weight: 700;
            letter-spacing: 1.5px;
            outline: none;
            text-align: center;
            box-shadow: inset 0 3px 12px rgba(0, 0, 0, 0.75);
            
            /* Responsive Wrapping */
            display: flex;
            align-items: center;
            justify-content: center;
            word-break: break-all;
            white-space: normal;
            line-height: 1.4;
            user-select: all;
            transition: border-color 0.2s ease;
        }

        .key-display-box.empty {
            color: #64748b;
            font-weight: 600;
            letter-spacing: 0.8px;
            font-size: 14px;
        }

        /* Action Buttons */
        .btn-stack {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 20px;
        }

        .btn-copy {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff;
            font-size: 14px;
            font-weight: 700;
            border: none;
            border-radius: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 9px;
            box-shadow: 0 8px 24px rgba(16, 185, 129, 0.35);
            transition: transform 0.15s ease, opacity 0.15s ease;
        }

        .btn-copy:active {
            transform: scale(0.97);
            opacity: 0.9;
        }

        .btn-copy.copied {
            background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
            box-shadow: 0 8px 24px rgba(6, 182, 212, 0.4);
        }

        .btn-support {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            padding: 12px;
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
            transform: scale(0.97);
        }

        /* Warning Box */
        .warning-box {
            background: rgba(244, 63, 94, 0.07);
            border: 1px solid rgba(244, 63, 94, 0.18);
            border-left: 4px solid #f43f5e;
            border-radius: 12px;
            padding: 13px 14px;
            display: flex;
            align-items: flex-start;
            gap: 11px;
            text-align: left;
            margin-bottom: 18px;
        }

        .warning-box i {
            color: #f43f5e;
            font-size: 15px;
            margin-top: 2px;
        }

        .warning-box p {
            color: #cbd5e1;
            font-size: 11px;
            line-height: 1.55;
            font-weight: 500;
        }

        /* Card Footer */
        .card-footer {
            padding-top: 15px;
            border-top: 1px solid rgba(255, 255, 255, 0.07);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 16px;
            font-size: 11px;
            color: #64748b;
            font-weight: 600;
        }

        .card-footer span {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .card-footer i {
            color: var(--neon-emerald);
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

        <div class="status-badge">${displayKey ? 'KEY READY' : 'NO ACCESS KEY'}</div>
        <h1 class="card-title">Your Authentication Key</h1>
        <p class="card-subtitle">Your Auth Key is generated and ready to use in the app.</p>

        <!-- Dynamic Fit Box -->
        <div class="key-wrapper">
            <div class="key-display-box ${displayKey ? '' : 'empty'}" id="authKeyContainer">
                ${displayKey ? displayKey : 'No Key Generated'}
            </div>
        </div>

        <!-- Buttons Stack -->
        <div class="btn-stack">
            <button class="btn-copy" id="copyBtn">
                <i class="far fa-copy"></i> <span>Copy Auth Key</span>
            </button>
            <a href="https://t.me/MultiverseBooks" target="_blank" rel="noopener noreferrer" class="btn-support">
                <i class="fab fa-telegram"></i> Need Help? Support
            </a>
        </div>

        <!-- Device Lock Advisory -->
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
            const copyBtn = document.getElementById('copyBtn');
            const authKeyContainer = document.getElementById('authKeyContainer');
            const btnText = copyBtn.querySelector('span');
            const btnIcon = copyBtn.querySelector('i');

            copyBtn.addEventListener('click', () => {
                const rawKey = authKeyContainer.innerText.trim();

                if (!rawKey || rawKey === 'No Key Generated') {
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
