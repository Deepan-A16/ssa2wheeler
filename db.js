// PostgreSQL Database Setup for Two-Wheeler Parking System (Neon Database Only)
require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

// SHA-256 helper function to keep usernames and passwords secret in DB
function hashSecret(val) {
  if (!val) return '';
  return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

let pool;

// Neon PostgreSQL Pool Configuration
const databaseUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : '';

const poolConfig = {
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
};

async function createPool() {
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is missing. Database is configured to connect ONLY to Neon PostgreSQL.');
    throw new Error('DATABASE_URL is missing. Please set DATABASE_URL in .env to connect to your Neon PostgreSQL database.');
  }

  const realPool = new Pool(poolConfig);
  try {
    const client = await realPool.connect();
    client.release();
    console.log('✅ Connected to Neon PostgreSQL Database.');
    return realPool;
  } catch (err) {
    realPool.end().catch(() => {});
    console.error('❌ Connection to Neon PostgreSQL Database failed:', err.message);
    throw err;
  }
}

// Initialize Database Tables & Sample Entries
async function initDatabase() {
  try {
    if (!pool) {
      pool = await createPool();
    }

    // 1. Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        role VARCHAR(50) NOT NULL DEFAULT 'owner',
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure email column exists on existing installations
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
    `);

    // 1b. Password Resets Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
    `);

    // 2. Parking Entries Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parking_entries (
        id SERIAL PRIMARY KEY,
        token_no INTEGER UNIQUE NOT NULL,
        barcode VARCHAR(255),
        veh_type VARCHAR(50) NOT NULL DEFAULT 'BIKE 15',
        veh_no VARCHAR(50) NOT NULL,
        cust_name VARCHAR(255),
        mobile_no VARCHAR(50),
        rate NUMERIC(10, 2) DEFAULT 15,
        payment_mode VARCHAR(50) DEFAULT 'CASH',
        in_date VARCHAR(50) NOT NULL,
        entry_time VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'ACTIVE',
        exit_time VARCHAR(50),
        total_hours INTEGER DEFAULT 1,
        total_amount NUMERIC(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Exit History Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exit_history (
        id SERIAL PRIMARY KEY,
        token_no INTEGER NOT NULL,
        barcode VARCHAR(255),
        veh_type VARCHAR(50) NOT NULL,
        veh_no VARCHAR(50) NOT NULL,
        cust_name VARCHAR(255),
        mobile_no VARCHAR(50),
        rate NUMERIC(10, 2),
        payment_mode VARCHAR(50),
        in_date VARCHAR(50) NOT NULL,
        entry_time VARCHAR(50) NOT NULL,
        exit_date VARCHAR(50) NOT NULL,
        exit_time VARCHAR(50) NOT NULL,
        fine_amount NUMERIC(10, 2) DEFAULT 0,
        total_amount NUMERIC(10, 2),
        exited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Fix null exited_at timestamps
    await pool.query(`UPDATE exit_history SET exited_at = CURRENT_TIMESTAMP WHERE exited_at IS NULL;`);

    // Verify PostgreSQL database schema
    console.log('PostgreSQL database tables & schema verified successfully.');
  } catch (err) {
    console.error('Error initializing PostgreSQL database schema:', err.message || err);
    throw err;
  }
}

let initPromise = null;

async function ensureInitialized() {
  if (!pool) {
    pool = await createPool();
  }
  if (!initPromise) {
    initPromise = initDatabase().catch(err => {
      initPromise = null;
      pool = null;
      throw err;
    });
  }
  await initPromise;
}

module.exports = {
  get pool() { return pool; },
  query: async (text, params) => {
    await ensureInitialized();
    return pool.query(text, params);
  }
};

