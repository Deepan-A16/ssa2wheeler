require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
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

// Google Drive Auto-Archiver & Database Purge Service
function getGoogleDriveClient() {
  const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
  let privateKey = process.env.GDRIVE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return null;
  }

  privateKey = privateKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']
  });

  return google.drive({ version: 'v3', auth });
}

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

async function archiveAndPurgeExitHistory() {
  try {
    const drive = getGoogleDriveClient();
    if (!drive) {
      console.log('⚠️ [Monthly Archive] Google Drive credentials not configured (GDRIVE_CLIENT_EMAIL / GDRIVE_PRIVATE_KEY). Skipping auto-archive.');
      return { success: false, message: 'Google Drive credentials not configured' };
    }

    const now = new Date();
    const firstDayCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const fetchSql = `
      SELECT * FROM exit_history 
      WHERE exited_at < $1
      ORDER BY id ASC
    `;
    const result = await db.query(fetchSql, [firstDayCurrentMonth]);

    if (!result.rows || result.rows.length === 0) {
      console.log('ℹ️ [Monthly Archive] No records older than 1 month to archive.');
      return { success: true, count: 0, message: 'No records older than 1 month to archive.' };
    }

    const recordsToArchive = result.rows;
    console.log(`📦 [Monthly Archive] Found ${recordsToArchive.length} records to archive and purge.`);

    const csvContent = convertRowsToCSV(recordsToArchive);
    
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthStr = String(prevMonthDate.getMonth() + 1).padStart(2, '0');
    const yearStr = prevMonthDate.getFullYear();
    const fileName = `SSA_Exit_History_Archive_${yearStr}_${monthStr}_${Date.now()}.csv`;

    const fileMetadata = {
      name: fileName,
      mimeType: 'text/csv'
    };

    if (process.env.GDRIVE_FOLDER_ID) {
      fileMetadata.parents = [process.env.GDRIVE_FOLDER_ID];
    }

    const media = {
      mimeType: 'text/csv',
      body: Readable.from([csvContent])
    };

    const uploadRes = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    });

    console.log(`✅ [Monthly Archive] File uploaded to Google Drive. File ID: ${uploadRes.data.id}`);

    const idsToDelete = recordsToArchive.map(r => r.id);
    await db.query(`DELETE FROM exit_history WHERE id = ANY($1::int[])`, [idsToDelete]);
    console.log(`🧹 [Monthly Archive] Successfully purged ${idsToDelete.length} records from PostgreSQL exit_history table.`);

    return {
      success: true,
      count: idsToDelete.length,
      fileId: uploadRes.data.id,
      fileName: fileName,
      fileLink: uploadRes.data.webViewLink
    };

  } catch (err) {
    console.error('❌ [Monthly Archive] Error during auto-archive:', err);
    return { success: false, error: err.message };
  }
}

// API Endpoint for Vercel Cron / Scheduled execution
app.all('/api/parking/archive/run', async (req, res) => {
  try {
    const result = await archiveAndPurgeExitHistory();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Backup Current Month Exit History to Google Drive WITHOUT purging database
app.post('/api/parking/archive/export-current-month', async (req, res) => {
  try {
    const drive = getGoogleDriveClient();
    if (!drive) {
      return res.status(400).json({ success: false, message: 'Google Drive credentials not configured in .env' });
    }

    const now = new Date();
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

    const fileMetadata = {
      name: fileName,
      mimeType: 'text/csv'
    };

    if (process.env.GDRIVE_FOLDER_ID) {
      fileMetadata.parents = [process.env.GDRIVE_FOLDER_ID];
    }

    const media = {
      mimeType: 'text/csv',
      body: Readable.from([csvContent])
    };

    const uploadRes = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    });

    res.json({
      success: true,
      count: records.length,
      fileId: uploadRes.data.id,
      fileName: fileName,
      fileLink: uploadRes.data.webViewLink,
      message: `Successfully uploaded ${records.length} current month exit records to Google Drive! No DB records were deleted.`
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

