require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { Readable } = require('stream');
const db = require('./db');


// SHA-256 helper function to keep usernames and passwords secret
function hashSecret(val) {
  if (!val) return '';
  return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

// Helper function to normalize PostgreSQL numeric string outputs to numbers
function formatEntryRow(row) {
  if (!row) return row;
  return {
    ...row,
    token_no: row.token_no !== null && row.token_no !== undefined ? parseInt(row.token_no, 10) : row.token_no,
    rate: row.rate !== null && row.rate !== undefined ? parseFloat(row.rate) : 15,
    fine_amount: row.fine_amount !== null && row.fine_amount !== undefined ? parseFloat(row.fine_amount) : 0,
    total_amount: row.total_amount !== null && row.total_amount !== undefined ? parseFloat(row.total_amount) : 0,
  };
}

const app = express();
const PORT = process.env.PORT || 5500;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// 1. User Authentication (Login)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required.' });
    }

    const hashedUsername = hashSecret(username);
    const hashedPassword = hashSecret(password);
    const query = `SELECT id, username, full_name, phone, role FROM users WHERE username = $1 AND password = $2`;
    
    const result = await db.query(query, [hashedUsername, hashedPassword]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials.' });

    res.json({
      success: true,
      message: 'Login successful!',
      user: {
        id: user.id,
        username: username,
        fullName: user.full_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: err.message ? `Database error: ${err.message}` : 'Database error.' });
  }
});

// 1b. Forgot Password Request
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if user exists with this email
    const userRes = await db.query(`SELECT id, username, full_name, email FROM users WHERE LOWER(email) = $1 OR email = $1`, [cleanEmail]);
    
    if (userRes.rows.length === 0) {
      // Privacy friendly response
      return res.json({
        success: true,
        message: 'If an account exists for that email, a password reset link has been sent.'
      });
    }

    const user = userRes.rows[0];

    // Generate secure random reset token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes TTL

    // Remove any previous active reset tokens for this user
    await db.query(`DELETE FROM password_resets WHERE user_id = $1`, [user.id]);

    // Save token hash & expiry in database
    await db.query(
      `INSERT INTO password_resets (user_id, email, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [user.id, user.email || cleanEmail, tokenHash, expiresAt]
    );

    // Build password reset URL
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:5500';
    const resetUrl = `${protocol}://${host}/reset-password.html?token=${rawToken}`;

    // Send email using Nodemailer
    const transporter = getEmailTransporter();
    if (transporter) {
      const mailOptions = {
        from: `"SSA Parking Support" <${process.env.GMAIL_USER}>`,
        to: user.email || cleanEmail,
        subject: 'Password Reset Request - SSA Two-Wheeler Parking System',
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 16px; background-color: #ffffff;">
            <h2 style="color: #064e3b; margin-top: 0; font-size: 22px;">Password Reset Request</h2>
            <p style="color: #374151; font-size: 15px; line-height: 1.6;">Hello ${user.full_name || 'User'},</p>
            <p style="color: #374151; font-size: 15px; line-height: 1.6;">We received a request to reset your password for the SSA Two-Wheeler Parking System account.</p>
            <div style="margin: 30px 0; text-align: center;">
              <a href="${resetUrl}" style="background-color: #059669; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">Reset Password</a>
            </div>
            <p style="color: #4b5563; font-size: 14px;">Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; font-size: 13px; color: #059669;"><a href="${resetUrl}" style="color: #059669;">${resetUrl}</a></p>
            <p style="color: #6b7280; font-size: 13px; margin-top: 24px; border-top: 1px solid #f3f4f6; padding-top: 16px;">This reset link will expire in <strong>15 minutes</strong>. If you did not request this, please ignore this email.</p>
          </div>
        `
      };
      await transporter.sendMail(mailOptions);
    } else {
      console.warn('⚠️ Nodemailer transporter unavailable. Reset URL generated:', resetUrl);
    }

    res.json({
      success: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
      ...(process.env.NODE_ENV !== 'production' ? { debugResetUrl: resetUrl } : {})
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ success: false, message: 'Server error processing password reset request.' });
  }
});

// 1c. Verify Reset Token
app.post('/api/auth/verify-reset-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, valid: false, message: 'Token is required.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await db.query(
      `SELECT pr.id, pr.expires_at, u.username, u.full_name 
       FROM password_resets pr 
       JOIN users u ON pr.user_id = u.id 
       WHERE pr.token_hash = $1 AND pr.expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, valid: false, message: 'Invalid or expired password reset link.' });
    }

    res.json({ success: true, valid: true, user: { fullName: result.rows[0].full_name } });
  } catch (err) {
    console.error('Verify reset token error:', err);
    res.status(500).json({ success: false, valid: false, message: 'Server error verifying token.' });
  }
});

// 1d. Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Reset token and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokenRes = await db.query(
      `SELECT pr.id, pr.user_id, pr.expires_at 
       FROM password_resets pr 
       WHERE pr.token_hash = $1 AND pr.expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired password reset link. Please request a new link.' });
    }

    const resetRecord = tokenRes.rows[0];
    const hashedPassword = hashSecret(newPassword);

    // Update user password in users table
    await db.query(`UPDATE users SET password = $1 WHERE id = $2`, [hashedPassword, resetRecord.user_id]);

    // Delete token after successful use
    await db.query(`DELETE FROM password_resets WHERE user_id = $1`, [resetRecord.user_id]);

    res.json({ success: true, message: 'Password changed successfully! You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Server error updating password.' });
  }
});

// 2. Get Next Available Token Number
app.get('/api/parking/next-token', async (req, res) => {
  try {
    const result = await db.query(`SELECT MAX(token_no) as max_token FROM parking_entries`);
    const row = result.rows[0];
    const nextToken = (row && row.max_token !== null && row.max_token !== undefined) ? (parseInt(row.max_token, 10) + 1) : 500;
    res.json({ success: true, nextToken });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Get All Parking Entries (with optional barcode / token search)
app.get('/api/parking/entries', async (req, res) => {
  try {
    const { barcode, tokenNo, search } = req.query;

    let sql = `SELECT * FROM parking_entries WHERE 1=1`;
    let params = [];
    let paramIndex = 1;

    if (barcode) {
      sql += ` AND barcode = $${paramIndex++}`;
      params.push(barcode);
    }
    if (tokenNo) {
      sql += ` AND token_no = $${paramIndex++}`;
      params.push(parseInt(tokenNo, 10));
    }
    if (search) {
      sql += ` AND (barcode ILIKE $${paramIndex} OR veh_no ILIKE $${paramIndex} OR cust_name ILIKE $${paramIndex} OR CAST(token_no AS TEXT) ILIKE $${paramIndex})`;
      paramIndex++;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY id DESC`;

    const result = await db.query(sql, params);
    const formattedEntries = result.rows.map(formatEntryRow);
    res.json({ success: true, count: formattedEntries.length, entries: formattedEntries });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Save New Parking Token Entry (including Card Barcode)
app.post('/api/parking/entry', async (req, res) => {
  try {
    let { tokenNo, barcode, vehType, vehNo, custName, mobileNo, rate, paymentMode, inDate, entryTime } = req.body;

    if (!vehNo) {
      return res.status(400).json({ success: false, message: 'Vehicle Number is required.' });
    }

    // Synchronize token number with card barcode number when barcode is scanned
    if (barcode) {
      const digits = barcode.replace(/\D/g, '');
      if (digits) {
        tokenNo = parseInt(digits, 10);
      }
    }

    const parsedToken = (tokenNo !== undefined && tokenNo !== null && tokenNo !== '') ? parseInt(tokenNo, 10) : 500;
    const now = new Date();
    const dateStr = inDate || now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
    const timeStr = entryTime || now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

    const cardBarcode = barcode || `CARD-${parsedToken}`;

    const sql = `
      INSERT INTO parking_entries (token_no, barcode, veh_type, veh_no, cust_name, mobile_no, rate, payment_mode, in_date, entry_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;

    const params = [
      parsedToken,
      cardBarcode,
      vehType || 'BIKE 15',
      vehNo.toUpperCase(),
      custName ? custName.toUpperCase() : '',
      mobileNo || '',
      rate !== undefined && rate !== null ? parseFloat(rate) : 15,
      paymentMode || 'CASH',
      dateStr,
      timeStr
    ];

    const result = await db.query(sql, params);
    const insertedId = result.rows[0].id;

    res.status(201).json({
      success: true,
      message: `Token #${parsedToken} saved and linked to Card Barcode [${cardBarcode}]!`,
      id: insertedId,
      tokenNo: parsedToken,
      barcode: cardBarcode
    });
  } catch (err) {
    if (err.code === '23505' || (err.message && err.message.includes('unique constraint'))) {
      return res.status(409).json({ success: false, message: `Token No ${req.body.tokenNo} already exists!` });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Lookup Vehicle by Barcode or Token for Exit Checkout (Exit - F12)
app.get('/api/parking/lookup', async (req, res) => {
  try {
    const query = (req.query.query || '').trim().toUpperCase();
    if (!query) return res.status(400).json({ success: false, message: 'Query is required.' });

    const numericToken = query.replace(/\D/g, '');
    const numericVal = (numericToken && !isNaN(parseInt(numericToken, 10))) ? parseInt(numericToken, 10) : -1;
    const formattedBarcode = numericToken ? `CARD-${numericToken}` : query;

    const sql = `
      SELECT * FROM parking_entries 
      WHERE barcode = $1 
         OR (token_no = $2 AND $2 != -1)
         OR ($3 != '' AND barcode = $3)
         OR veh_no ILIKE $4
      ORDER BY id DESC LIMIT 1
    `;
    const params = [query, numericVal, formattedBarcode, `%${query}%` ];

    const result = await db.query(sql, params);
    const row = formatEntryRow(result.rows[0]);

    if (!row) return res.status(404).json({ success: false, message: `No active vehicle found matching [${query}]` });

    res.json({ success: true, entry: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Calculate parking fee rule: ₹15 or ₹20 for each 12-hr period based on rate
function computeParkingFee(inDateStr, entryTimeStr, createdAtStr, baseRate = 15) {
  try {
    let entryDate = null;
    if (inDateStr && entryTimeStr) {
      let day, month, year;
      const dateParts = inDateStr.trim().split(/[\/\-]/);
      if (dateParts.length === 3) {
        if (dateParts[0].length === 4) {
          year = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          day = parseInt(dateParts[2], 10);
        } else {
          day = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          year = parseInt(dateParts[2], 10);
        }
      }

      const timeMatch = entryTimeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (year && month !== undefined && day && timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        let m = parseInt(timeMatch[2], 10);
        const ampm = timeMatch[3] ? timeMatch[3].toUpperCase() : '';

        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;

        entryDate = new Date(year, month, day, h, m, 0);
      }
    }

    if ((!entryDate || isNaN(entryDate.getTime())) && createdAtStr) {
      entryDate = new Date(createdAtStr);
    }

    const rate = parseFloat(baseRate) || 15;
    if (!entryDate || isNaN(entryDate.getTime())) {
      return rate;
    }

    const now = new Date();
    const diffMs = Math.max(0, now.getTime() - entryDate.getTime());
    const totalHours = diffMs / (1000 * 60 * 60);

    const hrs = Math.max(0.01, totalHours);
    const periods = Math.ceil(hrs / 12.0);
    return Math.max(1, periods) * rate;
  } catch (err) {
    return parseFloat(baseRate) || 15;
  }
}

// 6. Complete Vehicle Exit Checkout (Archives record to exit_history before clearing from active entries)
app.post('/api/parking/checkout', async (req, res) => {
  try {
    const { tokenNo, barcode, paymentMode, totalAmount, fineAmount } = req.body;
    const numericToken = (tokenNo && !isNaN(parseInt(tokenNo, 10))) ? parseInt(tokenNo, 10) : -1;
    const searchBarcode = barcode || '';

    const findSql = `SELECT * FROM parking_entries WHERE (token_no = $1 AND $1 != -1) OR (barcode != '' AND barcode = $2)`;
    const findRes = await db.query(findSql, [numericToken, searchBarcode]);
    const entry = findRes.rows[0];

    if (entry) {
      const now = new Date();
      const exitDate = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
      const exitTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      const finalFine = parseFloat(fineAmount) || 0;
      const entryRate = entry.rate !== null && entry.rate !== undefined ? parseFloat(entry.rate) : 15;
      const baseFee = computeParkingFee(entry.in_date, entry.entry_time, entry.created_at, entryRate);
      const finalAmount = totalAmount ? parseFloat(totalAmount) : (baseFee + finalFine);

      const archiveSql = `
        INSERT INTO exit_history (token_no, barcode, veh_type, veh_no, cust_name, mobile_no, rate, payment_mode, in_date, entry_time, exit_date, exit_time, fine_amount, total_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `;
      const params = [
        entry.token_no, entry.barcode, entry.veh_type, entry.veh_no, entry.cust_name, entry.mobile_no,
        entry.rate, paymentMode || entry.payment_mode || 'CASH', entry.in_date, entry.entry_time, exitDate, exitTime, finalFine, finalAmount
      ];

      await db.query(archiveSql, params);
      await db.query(`DELETE FROM parking_entries WHERE id = $1`, [entry.id]);

      return res.json({ success: true, message: `Vehicle Token #${entry.token_no} exit completed & archived to Exit History!` });
    } else {
      // Fallback delete if record exists under tokenNo / barcode
      await db.query(
        `DELETE FROM parking_entries WHERE (token_no = $1 AND $1 != -1) OR (barcode != '' AND barcode = $2)`,
        [numericToken, searchBarcode]
      );
      return res.json({ success: true, message: `Vehicle Token #${tokenNo} exit completed!` });
    }
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Helper to format YYYY-MM to MM/YYYY
function formatMonthSearch(yearMonthStr) {
  if (!yearMonthStr || !yearMonthStr.includes('-')) return '';
  const [yyyy, mm] = yearMonthStr.split('-');
  return `${mm}/${yyyy}`;
}

// 7. Get Past Exited Vehicle History (Supports monthly filtering)
app.get('/api/parking/history', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const month = (req.query.month || '').trim(); // e.g. '2026-08'

    let sql = `SELECT * FROM exit_history WHERE 1=1`;
    let params = [];
    let paramIdx = 1;

    if (month && month !== 'all') {
      const monthFormatted = formatMonthSearch(month);
      sql += ` AND (TO_CHAR(exited_at, 'YYYY-MM') = $${paramIdx} OR exit_date LIKE '%' || $${paramIdx + 1} || '%')`;
      params.push(month, monthFormatted);
      paramIdx += 2;
    }

    if (search) {
      sql += ` AND (CAST(token_no AS TEXT) ILIKE $${paramIdx} OR veh_no ILIKE $${paramIdx} OR barcode ILIKE $${paramIdx} OR cust_name ILIKE $${paramIdx} OR mobile_no ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }

    sql += ` ORDER BY id DESC LIMIT 1000`;

    const result = await db.query(sql, params);
    const rows = result.rows.map(formatEntryRow);

    let totalAmount = 0;
    let cashAmount = 0;
    let gpayAmount = 0;

    rows.forEach(r => {
      const amt = parseFloat(r.total_amount || r.rate || 0);
      totalAmount += amt;
      if ((r.payment_mode || '').toUpperCase() === 'GPAY') {
        gpayAmount += amt;
      } else {
        cashAmount += amt;
      }
    });

    res.json({
      success: true,
      count: rows.length,
      summary: {
        totalAmount,
        cashAmount,
        gpayAmount
      },
      history: rows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7b. Get List of Available Months in Exit History
app.get('/api/parking/history/months', async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT TO_CHAR(exited_at, 'YYYY-MM') as month_code 
      FROM exit_history 
      WHERE exited_at IS NOT NULL 
      ORDER BY month_code DESC
    `;
    const result = await db.query(sql);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthCodes = new Set(result.rows.map(r => r.month_code).filter(Boolean));
    monthCodes.add(currentMonth);

    const sortedMonths = Array.from(monthCodes).sort().reverse();
    res.json({ success: true, months: sortedMonths, currentMonth });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});




// 8. Clear All Parking Entries
app.delete('/api/parking/entries', async (req, res) => {
  try {
    await db.query(`DELETE FROM parking_entries`);
    res.json({ success: true, message: 'All parking entries cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.png'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =========================================================================
// EMAIL-BASED FILE UPLOADER CONFIGURATION (Nodemailer & Multer)
// =========================================================================

// Configure Multer with MemoryStorage (Essential for Vercel Serverless environment)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB limit per file
    files: 10                   // max 10 files
  }
});

// Helper function to create Nodemailer transporter using environment variables
function getEmailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_PASS;

  if (!user || !pass || user.includes('your_gmail')) {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user,
      pass: pass
    }
  });
}

// -------------------------------------------------------------------------
// POST /api/upload-email
// Handles form submission with multiple file attachments sent via Nodemailer
// -------------------------------------------------------------------------
app.post('/api/upload-email', upload.array('files', 10), async (req, res) => {
  try {
    const transporter = getEmailTransporter();
    if (!transporter) {
      return res.status(400).json({
        success: false,
        message: 'Gmail credentials not configured in environment variables (GMAIL_USER / GMAIL_PASS).'
      });
    }

    const recipient = process.env.RECIPIENT_EMAIL || process.env.GMAIL_USER;
    const { name, phone, vehicleNumber, email, vehicleType, notes, ...otherFields } = req.body;

    const files = req.files || [];
    const attachments = files.map(file => ({
      filename: file.originalname,
      content: file.buffer,
      contentType: file.mimetype
    }));

    // Construct form data HTML table
    const fieldRows = [
      { label: 'Full Name', value: name || 'N/A' },
      { label: 'Phone Number', value: phone || 'N/A' },
      { label: 'Vehicle Number', value: vehicleNumber || 'N/A' },
      { label: 'Vehicle Type', value: vehicleType || 'N/A' },
      { label: 'Email Address', value: email || 'N/A' },
      { label: 'Notes / Remarks', value: notes || 'N/A' }
    ];

    // Include any additional dynamic fields submitted in form
    for (const [key, value] of Object.entries(otherFields)) {
      fieldRows.push({ label: key, value: String(value) });
    }

    const tableHtml = fieldRows.map(row => `
      <tr>
        <td style="padding: 10px 14px; font-weight: bold; background-color: #f8fafc; color: #334155; border: 1px solid #e2e8f0; width: 35%;">${row.label}</td>
        <td style="padding: 10px 14px; color: #0f172a; border: 1px solid #e2e8f0;">${row.value}</td>
      </tr>
    `).join('');

    const fileListHtml = attachments.length > 0
      ? attachments.map((att, idx) => `<li><strong>Attachment #${idx + 1}:</strong> ${att.filename} (${(att.content.length / 1024).toFixed(1)} KB)</li>`).join('')
      : '<p><em>No files attached.</em></p>';

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <div style="background-color: #047857; color: #ffffff; padding: 16px 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h2 style="margin: 0; font-size: 20px;">SSA Parking - New File Upload Form Submission</h2>
        </div>
        <div style="padding: 20px 0;">
          <h3 style="color: #0f172a; border-bottom: 2px solid #047857; padding-bottom: 6px;">Submitted Form Details</h3>
          <table style="width: 100%; border-collapse: collapse; margin-top: 12px;">
            <tbody>
              ${tableHtml}
            </tbody>
          </table>
          <h3 style="color: #0f172a; border-bottom: 2px solid #047857; padding-bottom: 6px; margin-top: 24px;">Attached Files (${attachments.length})</h3>
          <ul style="color: #334155; padding-left: 20px;">
            ${fileListHtml}
          </ul>
        </div>
        <div style="font-size: 12px; color: #64748b; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 20px;">
          Received on: ${new Date().toLocaleString()} | SSA Two-Wheeler Parking System
        </div>
      </div>
    `;

    const plainText = `
SSA Parking - New Form Submission
==================================
Full Name: ${name || 'N/A'}
Phone Number: ${phone || 'N/A'}
Vehicle Number: ${vehicleNumber || 'N/A'}
Vehicle Type: ${vehicleType || 'N/A'}
Email: ${email || 'N/A'}
Notes: ${notes || 'N/A'}

Attached Files Count: ${attachments.length}
Submission Date: ${new Date().toLocaleString()}
    `.trim();

    const subject = `[SSA Upload] Submission from ${name || vehicleNumber || 'User'} (${attachments.length} file(s))`;

    const mailOptions = {
      from: `"SSA Parking System" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject: subject,
      text: plainText,
      html: htmlBody,
      attachments: attachments
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ [Email Upload] Email sent successfully! MessageId: ${info.messageId}`);

    return res.json({
      success: true,
      message: `Form submitted successfully! Email sent to ${recipient} with ${attachments.length} attachment(s).`,
      messageId: info.messageId
    });
  } catch (err) {
    console.error('❌ [Email Upload] Error sending email:', err);
    return res.status(500).json({
      success: false,
      message: `Failed to send email: ${err.message}`
    });
  }
});

function convertRowsToCSV(rows) {
  const headers = [
    'S.No', 'Token No', 'Barcode', 'Vehicle Type', 'Vehicle No', 
    'Customer Name', 'Mobile No', 'Rate', 'Payment Mode', 
    'In Date', 'Entry Time', 'Exit Date', 'Exit Time', 
    'Fine Amount', 'Total Amount', 'Exited At'
  ];

  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const csvLines = [headers.join(',')];

  rows.forEach((r, idx) => {
    const rowValues = [
      idx + 1,
      r.token_no,
      r.barcode || '',
      r.veh_type || '',
      r.veh_no || '',
      r.cust_name || '',
      r.mobile_no || '',
      r.rate || 0,
      r.payment_mode || 'CASH',
      r.in_date || '',
      r.entry_time || '',
      r.exit_date || '',
      r.exit_time || '',
      r.fine_amount || 0,
      r.total_amount || 0,
      r.exited_at ? new Date(r.exited_at).toISOString() : ''
    ];
    csvLines.push(rowValues.map(escapeCSV).join(','));
  });

  return csvLines.join('\n');
}

async function archiveAndPurgeExitHistory(purgeAll = false) {
  try {
    const transporter = getEmailTransporter();
    if (!transporter) {
      console.log('⚠️ [Monthly Archive] Gmail credentials not configured (GMAIL_USER / GMAIL_PASS). Skipping auto-archive.');
      return { success: false, message: 'Gmail credentials not configured' };
    }

    const now = new Date();
    const firstDayCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    let fetchSql;
    let params;

    if (purgeAll) {
      // Purge all exited history records up to now
      fetchSql = `SELECT * FROM exit_history ORDER BY id ASC`;
      params = [];
    } else {
      // Monthly auto-archive: records older than 1 month
      fetchSql = `SELECT * FROM exit_history WHERE exited_at < $1 ORDER BY id ASC`;
      params = [firstDayCurrentMonth];
    }

    const result = await db.query(fetchSql, params);

    if (!result.rows || result.rows.length === 0) {
      console.log('ℹ️ [Archive & Purge] No exited records found to archive.');
      return { success: true, count: 0, message: 'No exited records found to archive.' };
    }

    const recordsToArchive = result.rows;
    console.log(`📦 [Archive & Purge] Found ${recordsToArchive.length} exited records to email and purge.`);

    const csvContent = convertRowsToCSV(recordsToArchive);
    
    const monthStr = String(now.getMonth() + 1).padStart(2, '0');
    const yearStr = now.getFullYear();
    const fileName = `SSA_Exit_History_Archive_${yearStr}_${monthStr}_${Date.now()}.csv`;

    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const recipient = process.env.RECIPIENT_EMAIL || process.env.GMAIL_USER;
    await transporter.sendMail({
      from: `"SSA Parking System" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject: `[SSA Archive] Exit History Archive - ${dateStr} (${recordsToArchive.length} records)`,
      text: `Export Date: ${dateStr}\n\nAttached is the CSV archive containing ${recordsToArchive.length} exited vehicle records exported on ${dateStr}.\n\nNote: Active vehicles currently parked remain safely in the system.`,
      attachments: [{ filename: fileName, content: csvContent }]
    });

    console.log(`✅ [Archive & Purge] CSV archive emailed to ${recipient}`);

    const idsToDelete = recordsToArchive.map(r => r.id);
    await db.query(`DELETE FROM exit_history WHERE id = ANY($1::int[])`, [idsToDelete]);
    console.log(`🧹 [Archive & Purge] Successfully purged ${idsToDelete.length} exited records from exit_history. Active vehicles remain untouched.`);

    return {
      success: true,
      count: idsToDelete.length,
      fileName: fileName,
      message: `Emailed ${idsToDelete.length} exited vehicle record(s) to ${recipient} on ${dateStr} and purged them from exit history. Active vehicles remain untouched.`
    };

  } catch (err) {
    console.error('❌ [Archive & Purge] Error during archive & purge:', err);
    return { success: false, error: err.message };
  }
}

// API Endpoint for Vercel Cron / Scheduled execution (Monthly Auto Archive)
app.all('/api/parking/archive/run', async (req, res) => {
  try {
    const result = await archiveAndPurgeExitHistory(false);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API Endpoint to manual Email & Purge ALL Exited Vehicle Records (leaving Active Vehicles intact)
app.post('/api/parking/archive/purge-exited', async (req, res) => {
  try {
    const result = await archiveAndPurgeExitHistory(true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Export ALL Active Parked Vehicles via Email WITHOUT purging database
app.post('/api/parking/export-active-email', async (req, res) => {
  try {
    const transporter = getEmailTransporter();
    if (!transporter) {
      return res.status(400).json({ success: false, message: 'Gmail credentials not configured in .env' });
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

    // Fetch ALL active vehicles currently parked in parking_entries
    const fetchSql = `
      SELECT * FROM parking_entries 
      ORDER BY token_no ASC
    `;
    const result = await db.query(fetchSql);

    if (!result.rows || result.rows.length === 0) {
      return res.json({ success: true, count: 0, message: 'No active parked vehicles found in the system.' });
    }

    const records = result.rows;
    
    const headers = [
      'S.No', 'Token No', 'Barcode Card', 'Vehicle Type', 'Vehicle No', 
      'Customer Name', 'Mobile No', 'Rate', 'Payment Mode', 
      'In Date', 'Entry Time', 'Status', 'Entry Timestamp'
    ];

    const escapeCSV = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvLines = [headers.join(',')];

    records.forEach((r, idx) => {
      const rowValues = [
        idx + 1,
        r.token_no,
        r.barcode || '',
        r.veh_type || '',
        r.veh_no || '',
        r.cust_name || '',
        r.mobile_no || '',
        r.rate || 15,
        r.payment_mode || 'CASH',
        r.in_date || '',
        r.entry_time || '',
        r.status || 'ACTIVE',
        r.created_at ? new Date(r.created_at).toISOString() : ''
      ];
      csvLines.push(rowValues.map(escapeCSV).join(','));
    });

    const csvContent = csvLines.join('\n');

    const monthStr = String(now.getMonth() + 1).padStart(2, '0');
    const yearStr = now.getFullYear();
    const fileName = `SSA_All_Active_Vehicles_${yearStr}_${monthStr}_${Date.now()}.csv`;

    const recipient = process.env.RECIPIENT_EMAIL || process.env.GMAIL_USER;
    await transporter.sendMail({
      from: `"SSA Parking System" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject: `[SSA Active Vehicles] All Active Vehicles Export - ${dateStr} (${records.length} vehicles)`,
      text: `Export Date: ${dateStr}\n\nAttached is the CSV export containing all ${records.length} currently active parked vehicle(s) as of ${dateStr}.\n\nNo records were deleted from the system.`,
      attachments: [{ filename: fileName, content: csvContent }]
    });

    console.log(`✅ [All Active Vehicles Export] CSV emailed to ${recipient} (${records.length} active vehicles) on ${dateStr}`);

    res.json({
      success: true,
      count: records.length,
      fileName: fileName,
      message: `Successfully emailed all ${records.length} active vehicle record(s) to ${recipient} on ${dateStr}! No records were deleted.`
    });
  } catch (err) {
    console.error('Active vehicles export error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Backup Current Month Exit History via Email WITHOUT purging database
app.post('/api/parking/archive/export-current-month', async (req, res) => {
  try {
    const transporter = getEmailTransporter();
    if (!transporter) {
      return res.status(400).json({ success: false, message: 'Gmail credentials not configured in .env' });
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const firstDayCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const fetchSql = `
      SELECT * FROM exit_history 
      WHERE exited_at >= $1
      ORDER BY id ASC
    `;
    const result = await db.query(fetchSql, [firstDayCurrentMonth]);

    if (!result.rows || result.rows.length === 0) {
      return res.json({ success: true, count: 0, message: 'No exit records found for the current month.' });
    }

    const records = result.rows;
    const csvContent = convertRowsToCSV(records);
    
    const monthStr = String(now.getMonth() + 1).padStart(2, '0');
    const yearStr = now.getFullYear();
    const fileName = `SSA_Exit_History_CurrentMonth_${yearStr}_${monthStr}_${Date.now()}.csv`;

    const recipient = process.env.RECIPIENT_EMAIL || process.env.GMAIL_USER;
    await transporter.sendMail({
      from: `"SSA Parking System" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject: `[SSA Backup] Current Month Exit History Export - ${dateStr} (${records.length} records)`,
      text: `Export Date: ${dateStr}\n\nAttached is the current month exit history CSV export containing ${records.length} records as of ${dateStr}.`,
      attachments: [{ filename: fileName, content: csvContent }]
    });

    res.json({
      success: true,
      count: records.length,
      fileName: fileName,
      message: `Successfully emailed ${records.length} current month exit records to ${recipient} on ${dateStr}! No DB records were deleted.`
    });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

function startMonthlyArchiveScheduler() {
  setTimeout(() => {
    archiveAndPurgeExitHistory();
  }, 10000);

  setInterval(() => {
    const today = new Date();
    if (today.getDate() === 1 && today.getHours() === 1) {
      archiveAndPurgeExitHistory();
    }
  }, 24 * 60 * 60 * 1000);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Parking System with Card Barcode Support running on http://localhost:${PORT}`);
    startMonthlyArchiveScheduler();
  });
}

module.exports = app;

