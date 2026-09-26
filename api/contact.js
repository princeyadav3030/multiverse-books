export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const { firstName, lastName, email, subject, message } = req.body || {};

  // Basic validation
  if (!firstName || !email || !message) {
    return res.status(400).json({ 
      success: false, 
      error: "Kripya sabhi zaroori fields bharein." 
    });
  }

  // Email format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      success: false, 
      error: "Kripya valid email address darj karein." 
    });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const receiverEmail = process.env.RECEIVER_EMAIL;

  if (!apiKey || !receiverEmail) {
    return res.status(500).json({ 
      success: false, 
      error: "Server configuration missing. Environment variables check karein." 
    });
  }

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; background: #0b0c10; color: #ffffff; padding: 24px; border-radius: 12px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.15);">
      <h2 style="color: #38bdf8; border-bottom: 1.5px solid rgba(255,255,255,0.1); padding-bottom: 12px; margin-top: 0;">
        📩 New Support Query Received
      </h2>
      <table style="width: 100%; border-collapse: collapse; margin-top: 14px;">
        <tr>
          <td style="padding: 8px 0; color: #94a3b8; font-weight: bold; width: 30%;">Sender Name:</td>
          <td style="padding: 8px 0; color: #ffffff;">${firstName} ${lastName || ""}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #94a3b8; font-weight: bold;">Sender Email:</td>
          <td style="padding: 8px 0; color: #ffffff;"><a href="mailto:${email}" style="color: #38bdf8; text-decoration: none;">${email}</a></td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #94a3b8; font-weight: bold;">Issue Category:</td>
          <td style="padding: 8px 0; color: #f59e0b; font-weight: bold;">${subject || "General Inquiry"}</td>
        </tr>
      </table>

      <div style="margin-top: 18px; padding: 14px; background: rgba(255,255,255,0.05); border-radius: 8px; border-left: 3px solid #10b981;">
        <p style="margin: 0; color: #94a3b8; font-size: 11px; font-weight: bold; text-transform: uppercase;">User Message:</p>
        <p style="margin: 8px 0 0 0; color: #f1f5f9; line-height: 1.6; white-space: pre-wrap;">${message}</p>
      </div>

      <div style="margin-top: 22px; border-top: 1px dashed rgba(255,255,255,0.15); padding-top: 10px; font-size: 11px; color: #64748b; text-align: center;">
        Spidy Book Hub • Powered by Native Serverless API
      </div>
    </div>
  `;

  try {
    // Native fetch call directly to Resend REST API (No npm library needed)
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Spidy Support <onboarding@resend.dev>",
        to: [receiverEmail],
        reply_to: email,
        subject: `[Spidy Hub Support] ${subject || "New Query"} - ${firstName}`,
        html: htmlContent
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Resend API Error:", data);
      return res.status(response.status).json({ 
        success: false, 
        error: data.message || "Email send karne me error aayi." 
      });
    }

    return res.status(200).json({ 
      success: true, 
      message: "Message successfully sent" 
    });

  } catch (error) {
    console.error("Serverless Function Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: "Network error. Kripya baad me koshish karein." 
    });
  }
}
