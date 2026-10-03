// File: api/generate.js

const { db } = require('../utils/firebaseAdmin');
const crypto = require('crypto');

function generateRandomKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'SPIDY-';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  let displayKey = "";
  const now = Date.now();

  // Check karein agar query me code pehle se hai ya naya banana hai
  let incomingCode = req.query.code || req.query.key || null;

  try {
    if (incomingCode) {
      // Agar URL me pehle se code hai (e.g. ?code=XYZ)
      displayKey = incomingCode;
    } else {
      // Naya unique 10-day token generate karein
      const newKey = generateRandomKey();
      const expiresAt = now + (10 * 24 * 60 * 60 * 1000); // 10 Din

      await db.collection('tokens').doc(newKey).set({
        token: newKey,
        used: false,
        createdAt: now,
        expiresAt: expiresAt,
        deviceBound: null, // First verify par device lock hoga
        isActivated: true,
        source: 'shortlink_generated'
      });

      displayKey = newKey;
    }
  } catch (err) {
    console.error("Token Generation Error:", err);
    displayKey = "ERROR_GENERATING_KEY";
  }

  // HTML Response Render karein (Aapka Diya Hua UI)
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Spidy Book Hub - Auth Key</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Fira+Code:wght@500;600&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Poppins', sans-serif;
        }

        body {
            background-color: #020617;
            background-image: 
                radial-gradient(circle at 15% 50%, rgba(16, 185, 129, 0.08) 0%, transparent 40%),
                radial-gradient(circle at 85% 30%, rgba(6, 182, 212, 0.12) 0%, transparent 40%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            color: #ffffff;
            padding: 20px;
            overflow: hidden;
            position: relative;
        }

        body::before {
            content: '';
            position: absolute;
            inset: 0;
            background: 
                linear-gradient(rgba(255, 255, 255, 0.015) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
            background-size: 30px 30px;
            z-index: 0;
            opacity: 0.5;
        }

        .ambient-glow {
            position: absolute;
            width: 300px; 
            height: 300px;
            background: rgba(6, 182, 212, 0.25);
            filter: blur(100px);
            border-radius: 50%;
            z-index: 0;
            animation: pulse-glow 4s infinite alternate;
        }

        @keyframes pulse-glow {
            0% { transform: scale(1); opacity: 0.5; }
            100% { transform: scale(1.1); opacity: 0.8; }
        }

        .auth-card {
            background: rgba(15, 23, 42, 0.75);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            width: 100%;
            max-width: 420px;
            border-radius: 16px;
            padding: 35px 30px;
            position: relative;
            z-index: 1;
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-top: none; 
            box-shadow: 
                0 25px 50px rgba(0, 0, 0, 0.7), 
                inset 0 0 20px rgba(255, 255, 255, 0.02),
                inset 0 4px 15px rgba(6, 182, 212, 0.15); 
            text-align: center;
            overflow: hidden;
        }

        .auth-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 3px;
            background: linear-gradient(90deg, #06b6d4, #10b981, #0ea5e9, #10b981, #06b6d4);
            background-size: 200% 100%;
            animation: gradient-sweep 3s linear infinite;
            z-index: 10;
        }

        @keyframes gradient-sweep {
            0% { background-position: 0% 0; }
            100% { background-position: 200% 0; }
        }

        .icon-circle {
            width: 60px;
            height: 60px;
            background: rgba(6, 182, 212, 0.1);
            border: 1px solid rgba(6, 182, 212, 0.3);
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 15px;
            color: #06b6d4;
            font-size: 24px;
            box-shadow: 0 0 20px rgba(6, 182, 212, 0.2);
            animation: float-icon 3s ease-in-out infinite;
        }

        @keyframes float-icon {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-5px); }
        }

        .auth-card h2 {
            font-size: 22px;
            font-weight: 600;
            margin-bottom: 8px;
            background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .auth-card p.subtitle {
            color: #94a3b8;
            font-size: 13px;
            margin-bottom: 25px;
        }

        .key-container {
            position: relative;
            margin-bottom: 20px;
        }

        .key-input {
            width: 100%;
            background: rgba(0, 0, 0, 0.4);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            padding: 16px;
            color: #34d399;
            font-family: 'Fira Code', monospace;
            font-size: 18px;
            font-weight: 600;
            text-align: center;
            letter-spacing: 2px;
            outline: none;
            box-shadow: inset 0 4px 10px rgba(0, 0, 0, 0.6);
        }

        .copy-btn {
            width: 100%;
            background: linear-gradient(135deg, #06b6d4 0%, #059669 100%);
            color: white;
            border: none;
            padding: 14px;
            border-radius: 12px;
            font-size: 14.5px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 8px;
            transition: all 0.3s ease;
            box-shadow: 0 5px 15px rgba(6, 182, 212, 0.25);
            margin-bottom: 25px;
            text-decoration: none;
        }

        .copy-btn:hover {
            box-shadow: 0 8px 25px rgba(6, 182, 212, 0.45);
            transform: translateY(-2px);
        }

        .copy-btn:active {
            transform: translateY(1px);
        }

        .copy-btn.copied {
            background: linear-gradient(135deg, #10b981 0%, #047857 100%);
            box-shadow: 0 5px 15px rgba(16, 185, 129, 0.3);
        }

        .warning-box {
            background: rgba(244, 63, 94, 0.06); 
            border: 1px solid rgba(244, 63, 94, 0.15); 
            border-left: 4px solid #f43f5e; 
            border-radius: 8px;
            padding: 15px 15px 15px 18px;
            display: flex;
            align-items: flex-start;
            gap: 12px;
            text-align: left;
            margin-bottom: 25px;
            box-shadow: 0 4px 15px rgba(244, 63, 94, 0.1); 
            position: relative;
        }

        .warning-box i {
            color: #f43f5e; 
            font-size: 16px;
            margin-top: 3px;
            filter: drop-shadow(0 0 5px rgba(244, 63, 94, 0.5)); 
        }

        .warning-box p {
            color: #cbd5e1;
            font-size: 11px;
            line-height: 1.6;
        }

        .card-footer {
            display: flex;
            justify-content: center;
            gap: 20px;
            color: #64748b;
            font-size: 11px;
            font-weight: 500;
        }

        .card-footer span {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .card-footer i {
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="ambient-glow"></div>

    <div class="auth-card">
        <div class="card-header">
            <div class="icon-circle">
                <i class="fas fa-key"></i>
            </div>
            <h2>Your Authentication Key</h2>
            <p class="subtitle">Your Auth Key is generated and ready to use in the app.</p>
        </div>

        <div class="key-container">
            <input type="text" class="key-input" id="authKeyInput" value="${displayKey}" readonly>
        </div>

        <button class="copy-btn" id="copyBtn">
            <i class="far fa-copy"></i> <span>Copy Auth Key</span>
        </button>

        <div class="warning-box">
            <i class="fas fa-exclamation-circle"></i>
            <p>This Auth Key is valid for 10 Days. Enter this key on Spidy Book Hub to unlock access. It will automatically bind to your device upon first verification.</p>
        </div>

        <div class="card-footer">
            <span><i class="far fa-clock"></i> Valid for 10 Days</span>
            <span><i class="fas fa-shield-alt"></i> Secure connection</span>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const copyBtn = document.getElementById('copyBtn');
            const authKeyInput = document.getElementById('authKeyInput');
            const btnText = copyBtn.querySelector('span');
            const btnIcon = copyBtn.querySelector('i');

            copyBtn.addEventListener('click', () => {
                authKeyInput.select();
                authKeyInput.setSelectionRange(0, 99999);

                navigator.clipboard.writeText(authKeyInput.value).then(() => {
                    copyBtn.classList.add('copied');
                    btnIcon.className = 'fas fa-check';
                    btnText.innerText = 'Copied Successfully!';
                    
                    setTimeout(() => {
                        copyBtn.classList.remove('copied');
                        btnIcon.className = 'far fa-copy';
                        btnText.innerText = 'Copy Auth Key';
                    }, 3000);
                }).catch(err => {
                    btnText.innerText = 'Failed to copy';
                });
            });
        });
    </script>
</body>
</html>
  `);
};
