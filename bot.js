
const axios = require('axios');
const cron = require('node-cron');

// ======================= CONFIGURATION =======================
// Read from environment variables (set in Railway dashboard)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || '2fb822c09c1c42e19c07e94090f18b42';
const PORT = process.env.PORT || 3000;

// Assets to monitor (only forex)
const FOREX_ASSETS = ['EUR/USD', 'GBP/USD'];

// Session times (WAT - UTC+1)
const SESSIONS = [
  { start: 8, end: 10 },   // 8:00 AM - 10:00 AM
  { start: 13, end: 18 }   // 1:00 PM - 6:00 PM
];

// Trading days: Monday = 1, Friday = 5
const TRADING_DAYS = [1, 2, 3, 4, 5];

// Tracking state
let lastSignals = {};        // { asset: 'BUY'/'SELL'/'NEUTRAL' }
let pendingSignals = {};     // { asset: { direction, entryPrice, expiryTime, displayName } }
let isAnalyzing = false;

// ======================= HELPER FUNCTIONS =======================
function getWATTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
}

function isTradingActive() {
  const now = getWATTime();
  const day = now.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
  const hour = now.getHours();
  
  // Check if trading day (Monday to Friday)
  if (!TRADING_DAYS.includes(day)) return false;
  
  // Check if within any session window
  for (const session of SESSIONS) {
    if (hour >= session.start && hour < session.end) {
      return true;
    }
  }
  return false;
}

function getTradeWindowInfo() {
  const now = getWATTime();
  const minutes = now.getMinutes();
  
  // Round to next 5-minute mark (0,5,10,15,...55)
  const nextFiveMin = Math.ceil((minutes + 0.1) / 5) * 5;
  const nextSignalTime = new Date(now);
  nextSignalTime.setMinutes(nextFiveMin, 0, 0);
  
  // Entry window: 2 minutes after signal time
  const entryEnd = new Date(nextSignalTime);
  entryEnd.setMinutes(entryEnd.getMinutes() + 2);
  
  // Trade expiry: 7 minutes after signal time
  const tradeExpiry = new Date(nextSignalTime);
  tradeExpiry.setMinutes(tradeExpiry.getMinutes() + 7);
  
  const timeUntilSignal = Math.max(0, (nextSignalTime - now) / 1000);
  const isInEntryWindow = now >= nextSignalTime && now < entryEnd;
  
  return { nextSignalTime, entryEnd, tradeExpiry, timeUntilSignal, isInEntryWindow };
}

function formatPrice(price) {
  if (!price) return '—';
  return price.toFixed(5);
}

// ======================= TELEGRAM FUNCTIONS =======================
async function sendToChannel(message, isMarkdown = true) {
  if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.log('[BOT] No valid BOT_TOKEN, would send:', message.substring(0, 100));
    return false;
  }
  
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const response = await axios.post(url, {
      chat_id: CHANNEL_ID,
      text: message,
      parse_mode: isMarkdown ? 'Markdown' : undefined,
      disable_web_page_preview: true
    });
    return response.data.ok;
  } catch (error) {
    console.error('[TELEGRAM] Send error:', error.response?.data || error.message);
    return false;
  }
}

async function sendStatusUpdate() {
  const activeSignals = Object.keys(pendingSignals).length;
  const now = getWATTime();
  const windowInfo = getTradeWindowInfo();
  
  const statusMsg = `🤖 *Trend Pulse Status*
  
📊 Monitoring: EUR/USD, GBP/USD
⏰ Trading active: ${isTradingActive() ? '✅ YES' : '❌ NO'}
📈 Active signals: ${activeSignals}
⏱ Next signal: ${windowInfo.nextSignalTime.toLocaleTimeString('en-GB')}
🕒 Server time: ${now.toLocaleTimeString('en-GB')}`;
  
  await sendToChannel(statusMsg, true);
}

// ======================= WIN/LOSS VERIFICATION =======================
async function verifyAndSendResult(signalData) {
  const { asset, direction, entryPrice, expiryTime, displayName } = signalData;
  
  try {
    // Fetch price after expiry
    const closes = await fetchForexData(asset);
    if (!closes || closes.length === 0) return;
    
    const expiryPrice = closes[closes.length - 1];
    const priceChange = ((expiryPrice - entryPrice) / entryPrice) * 100;
    
    let result = '';
    if (direction === 'BUY') {
      result = expiryPrice > entryPrice ? 'Win ✅' : 'Loss ❌';
    } else {
      result = expiryPrice < entryPrice ? 'Win ✅' : 'Loss ❌';
    }
    
    const resultMsg = `📊 *RESULT UPDATE* 📊

${direction === 'BUY' ? '🟢' : '🔴'} *${direction} SIGNAL* for *${displayName}*

💰 Entry: ${formatPrice(entryPrice)}
💰 Expiry: ${formatPrice(expiryPrice)}
📈 Change: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(4)}%

🎯 *Result: ${result}*`;
    
    await sendToChannel(resultMsg, true);
    console.log(`[VERIFY] ${asset}: ${result} (${priceChange.toFixed(4)}%)`);
  } catch (err) {
    console.error(`[VERIFY] Error for ${asset}:`, err.message);
  }
}

function checkExpiredSignals() {
  const now = getWATTime();
  for (const asset in pendingSignals) {
    const signal = pendingSignals[asset];
    if (now >= signal.expiryTime) {
      verifyAndSendResult(signal);
      delete pendingSignals[asset];
    }
  }
}

// ======================= API & TECHNICAL ANALYSIS =======================
async function fetchForexData(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=5min&outputsize=55&apikey=${TWELVE_DATA_KEY}`;
  const response = await axios.get(url);
  const json = response.data;
  if (json.status === 'error' || !json.values) throw new Error(json.message);
  const values = json.values.reverse();
  return values.map(v => parseFloat(v.close));
}

function calculateEMA(prices, period) {
  if (!prices.length) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
    let diff = prices[i+1] - prices[i];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  let rs = gains / losses;
  return Math.min(100, Math.max(0, 100 - (100 / (1 + rs))));
}

function detectTrend(prices) {
  if (!prices || prices.length < 25) return { trend: 'NEUTRAL', confidence: 50 };
  
  const ema9 = calculateEMA(prices, 9);
  const ema21 = calculateEMA(prices, 21);
  const ema50 = calculateEMA(prices, 50);
  const rsi = calculateRSI(prices, 14);
  const currentPrice = prices[prices.length-1];
  const price5Ago = prices[prices.length-6];
  const momentumPercent = ((currentPrice - price5Ago) / price5Ago) * 100;
  
  let bullishScore = 0, bearishScore = 0;
  
  // EMA alignment
  if (ema9 > ema21) bullishScore += 30;
  else if (ema9 < ema21) bearishScore += 30;
  
  if (ema21 > ema50) bullishScore += 20;
  else if (ema21 < ema50) bearishScore += 20;
  
  // RSI
  if (rsi > 55) bullishScore += 22;
  else if (rsi < 45) bearishScore += 22;
  
  // Momentum
  if (momentumPercent > 0.15) bullishScore += Math.min(28, momentumPercent * 2);
  else if (momentumPercent < -0.15) bearishScore += Math.min(28, Math.abs(momentumPercent) * 2);
  
  let trend = 'NEUTRAL';
  let confidence = 50;
  
  if (bullishScore > bearishScore + 12) {
    trend = 'BULLISH';
    confidence = Math.min(92, 65 + Math.floor((bullishScore - bearishScore) / 2));
  } else if (bearishScore > bullishScore + 12) {
    trend = 'BEARISH';
    confidence = Math.min(92, 65 + Math.floor((bearishScore - bullishScore) / 2));
  }
  
  return { trend, confidence, rsi: rsi.toFixed(1), momentumPercent: momentumPercent.toFixed(3), currentPrice };
}

async function analyzeAsset(asset) {
  const displayName = asset;
  try {
    const closes = await fetchForexData(asset);
    if (!closes || closes.length < 25) return null;
    
    const result = detectTrend(closes);
    const currentPrice = result.currentPrice || closes[closes.length-1];
    const prevPrice = closes[closes.length-2] || currentPrice;
    const changePercent = ((currentPrice - prevPrice) / prevPrice * 100).toFixed(4);
    const finalSignal = result.trend === 'BULLISH' ? 'BUY' : (result.trend === 'BEARISH' ? 'SELL' : 'NEUTRAL');
    
    const lastSignal = lastSignals[asset];
    const windowInfo = getTradeWindowInfo();
    
    // Send signal only if conditions met
    if (finalSignal !== 'NEUTRAL' && lastSignal !== finalSignal && 
        windowInfo.isInEntryWindow && isTradingActive()) {
      
      const signalMsg = `${finalSignal === 'BUY' ? '🟢' : '🔴'} *${finalSignal} SIGNAL* 🔔

📊 *Asset:* ${displayName}
💰 *Price:* ${formatPrice(currentPrice)}
📈 *5m Change:* ${changePercent}%
🎯 *Confidence:* ${result.confidence}%

⏰ *Entry Window:* Closes at ${windowInfo.entryEnd.toLocaleTimeString('en-GB')}
⏱ *Trade Expiry:* ${windowInfo.tradeExpiry.toLocaleTimeString('en-GB')}

⚠️ *Execute within 2 minutes!*`;
      
      const sent = await sendToChannel(signalMsg, true);
      if (sent) {
        lastSignals[asset] = finalSignal;
        
        pendingSignals[asset] = {
          asset: asset,
          direction: finalSignal,
          entryPrice: currentPrice,
          entryTime: getWATTime(),
          expiryTime: windowInfo.tradeExpiry,
          displayName: displayName
        };
        console.log(`[SIGNAL] ${asset}: ${finalSignal} at ${formatPrice(currentPrice)}`);
      }
    } else if (finalSignal === 'NEUTRAL') {
      lastSignals[asset] = null;
    }
    
    return { asset, displayName, result, currentPrice, changePercent, finalSignal };
  } catch (err) {
    console.error(`[ERROR] ${asset}:`, err.message);
    return null;
  }
}

async function runFullAnalysis() {
  if (isAnalyzing) return;
  isAnalyzing = true;
  
  const active = isTradingActive();
  if (!active) {
    console.log(`[BOT] Trading session inactive. Idle until next session.`);
    isAnalyzing = false;
    return;
  }
  
  console.log(`[SCAN] ${new Date().toLocaleTimeString()} - Analyzing ${FOREX_ASSETS.length} assets...`);
  
  for (const asset of FOREX_ASSETS) {
    await analyzeAsset(asset);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  checkExpiredSignals();
  
  const pendingCount = Object.keys(pendingSignals).length;
  if (pendingCount > 0) {
    console.log(`[STATUS] Active pending signals: ${pendingCount}`);
  }
  
  isAnalyzing = false;
}

// ======================= EXPRESS SERVER (Required for Railway) =======================
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Trend Pulse Bot</title></head>
    <body style="background:#0a0a0a;color:#00e599;font-family:monospace;text-align:center;padding:50px;">
      <h1>🤖 Trend Pulse Bot</h1>
      <p>Status: <strong style="color:#00ff88;">🟢 ONLINE</strong></p>
      <p>Monitoring: EUR/USD, GBP/USD</p>
      <p>Sessions: 8-10am & 1-6pm WAT (Mon-Fri)</p>
      <p>Active signals: ${Object.keys(pendingSignals).length}</p>
      <hr>
      <small>Last scan: ${new Date().toLocaleTimeString()}</small>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'online', 
    trading: isTradingActive(),
    signals: Object.keys(pendingSignals).length,
    time: getWATTime().toISOString()
  });
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`[SERVER] Health check available on port ${PORT}`);
});

// ======================= SCHEDULED TASKS =======================
// Run every minute to check signal timing
cron.schedule('* * * * *', async () => {
  const now = getWATTime();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  
  // Run at exact 5-minute marks (0,5,10,...55)
  if (minutes % 5 === 0 && seconds < 10) {
    await runFullAnalysis();
  }
  // Also run during entry windows
  const windowInfo = getTradeWindowInfo();
  if (windowInfo.isInEntryWindow && seconds % 30 === 0) {
    await runFullAnalysis();
  }
  // Check for expired signals every minute
  if (seconds < 5) {
    checkExpiredSignals();
  }
});

// Status update every hour
cron.schedule('0 * * * *', async () => {
  if (isTradingActive()) {
    await sendStatusUpdate();
  }
});

// Morning session start notification (7:55 AM)
cron.schedule('55 7 * * *', async () => {
  const now = getWATTime();
  if (TRADING_DAYS.includes(now.getDay())) {
    await sendToChannel('🌅 *Morning Session Starting Soon*\n\nTrading session: 8:00 - 10:00 WAT\nMonitoring EUR/USD and GBP/USD\n\nGet ready!', true);
  }
});

// Afternoon session start notification (12:55 PM)
cron.schedule('55 12 * * *', async () => {
  const now = getWATTime();
  if (TRADING_DAYS.includes(now.getDay())) {
    await sendToChannel('🌤 *Afternoon Session Starting Soon*\n\nTrading session: 13:00 - 18:00 WAT\nMonitoring active.\n\nHappy trading!', true);
  }
});

// ======================= INITIALIZATION =======================
console.log('═══════════════════════════════════════════');
console.log('🤖 TREND PULSE BOT - Node.js Version');
console.log('═══════════════════════════════════════════');
console.log(`📊 Monitoring: ${FOREX_ASSETS.join(', ')}`);
console.log(`⏰ Session 1: 8:00 - 10:00 WAT (Mon-Fri)`);
console.log(`⏰ Session 2: 13:00 - 18:00 WAT (Mon-Fri)`);
console.log(`📡 Telegram Bot: ${BOT_TOKEN && BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE' ? 'CONFIGURED ✅' : 'NOT SET ⚠️'}`);
console.log(`🌐 Health check: http://localhost:${PORT}`);
console.log('═══════════════════════════════════════════\n');

// Send startup message
if (BOT_TOKEN && BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE') {
  setTimeout(async () => {
    await sendToChannel('🤖 *Trend Pulse Bot Started*\n\n✅ Monitoring EUR/USD and GBP/USD\n⏰ Sessions: 8-10am & 1-6pm WAT (Mon-Fri)\n📊 Auto win/loss verification enabled\n\nBot is live and ready!', true);
  }, 2000);
} else {
  console.log('[WARN] Please set TELEGRAM_BOT_TOKEN and CHANNEL_ID environment variables');
  console.log('[WARN] Bot running in demo mode (no messages will be sent)');
}

console.log('[BOT] Active and monitoring...');
