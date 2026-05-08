// trend-pulse-bot.js
// Node.js Telegram Signal Bot for EUR/USD and GBP/USD
// Sessions: Mon-Fri | 8:00-10:00 WAT & 13:00-18:00 WAT

const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ======================= CONFIGURATION =======================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CHANNEL_ID = process.env.CHANNEL_ID || 'YOUR_CHANNEL_ID_HERE';
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || '2fb822c09c1c42e19c07e94090f18b42';

// Assets to monitor (only forex)
const FOREX_ASSETS = ['EUR/USD', 'GBP/USD'];

// Session times (WAT - UTC+1)
const SESSIONS = [
  { start: 8, end: 10 },   // 8:00 AM - 10:00 AM
  { start: 13, end: 18 }   // 1:00 PM - 6:00 PM
];

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
  const minute = now.getMinutes();
  
  // Monday to Friday only (1-5)
  if (day === 0 || day === 6) return false;
  
  // Check if within any session window
  for (const session of SESSIONS) {
    if (hour >= session.start && hour < session.end) {
      return true;
    }
    // Handle session end time exactly (e.g., until 18:00, not including 18:01)
    if (hour === session.end - 1 && minute >= 0) return true;
  }
  return false;
}

function getTradeWindowInfo() {
  const now = getWATTime();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  
  // Round to next 5-minute mark for signal (0,5,10,15,20,25,30,35,40,45,50,55)
  const nextFiveMin = Math.ceil((minutes + 0.1) / 5) * 5;
  const nextSignalTime = new Date(now);
  nextSignalTime.setMinutes(nextFiveMin, 0, 0);
  
  // Entry window: 2 minutes after signal time
  const entryStart = new Date(nextSignalTime);
  const entryEnd = new Date(nextSignalTime);
  entryEnd.setMinutes(entryEnd.getMinutes() + 2);
  
  // Trade expiry: 7 minutes after signal time (not 7 minutes after entry)
  const tradeExpiry = new Date(nextSignalTime);
  tradeExpiry.setMinutes(tradeExpiry.getMinutes() + 7);
  
  const timeUntilSignal = Math.max(0, (nextSignalTime - now) / 1000);
  const isInEntryWindow = now >= entryStart && now < entryEnd;
  
  return { nextSignalTime, entryStart, entryEnd, tradeExpiry, timeUntilSignal, isInEntryWindow };
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
  const statusMsg = `🤖 *Bot Status* (${now.toLocaleTimeString('en-GB')})
  
📊 Monitoring: EUR/USD, GBP/USD
⏰ Next signal: ${getNextSignalTime()}
📈 Active signals: ${activeSignals}
🕒 Trading hours active: ${isTradingActive()}`;
  await sendToChannel(statusMsg, true);
}

function getNextSignalTime() {
  const info = getTradeWindowInfo();
  return info.nextSignalTime.toLocaleTimeString('en-GB');
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
    
    // Send signal only if:
    // 1. Trend is not neutral
    // 2. Signal changed (BUY->SELL or SELL->BUY or NEUTRAL->signal)
    // 3. Within entry window (2 minutes after 5-min mark)
    // 4. Trading session is active
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
        
        // Register pending signal for win/loss verification
        pendingSignals[asset] = {
          asset: asset,
          direction: finalSignal,
          entryPrice: currentPrice,
          entryTime: getWATTime(),
          expiryTime: windowInfo.tradeExpiry,
          displayName: displayName
        };
        console.log(`[SIGNAL] ${asset}: ${finalSignal} at ${formatPrice(currentPrice)} | Expires: ${windowInfo.tradeExpiry.toLocaleTimeString()}`);
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
    console.log(`[BOT] Trading session inactive. Sensors idle.`);
    isAnalyzing = false;
    return;
  }
  
  console.log(`[SCAN] ${new Date().toLocaleTimeString()} - Analyzing ${FOREX_ASSETS.length} assets...`);
  
  for (const asset of FOREX_ASSETS) {
    await analyzeAsset(asset);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Check for expired signals
  checkExpiredSignals();
  
  const pendingCount = Object.keys(pendingSignals).length;
  if (pendingCount > 0) {
    console.log(`[STATUS] Active pending signals: ${pendingCount}`);
  }
  
  isAnalyzing = false;
}

function formatPrice(price) {
  if (!price) return '—';
  return price.toFixed(5);
}

// ======================= SESSION SCHEDULING =======================
// Run every minute to catch the exact 5-minute marks
function startScheduledAnalysis() {
  // Run analysis every minute (to catch signal windows precisely)
  cron.schedule('* * * * *', async () => {
    const now = getWATTime();
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    
    // Run analysis exactly at :00, :05, :10, etc. and also during entry window
    const isSignalTime = minutes % 5 === 0;
    const windowInfo = getTradeWindowInfo();
    
    if (isSignalTime && seconds < 10) {
      // At the 5-minute mark, run analysis for signals
      await runFullAnalysis();
    } else if (windowInfo.isInEntryWindow) {
      // During entry window, also run analysis to catch signals
      await runFullAnalysis();
    } else if (seconds === 30) {
      // Run status check every minute at :30
      const pendingCount = Object.keys(pendingSignals).length;
      if (pendingCount > 0) {
        checkExpiredSignals();
      }
    }
  });
}

function startSessionMonitor() {
  // Log session status every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    const active = isTradingActive();
    const nextInfo = getTradeWindowInfo();
    console.log(`[MONITOR] ${getWATTime().toLocaleTimeString()} | Trading: ${active ? 'ACTIVE' : 'IDLE'} | Next signal: ${nextInfo.nextSignalTime.toLocaleTimeString()}`);
    
    // Send status to Telegram every hour during active session
    const now = getWATTime();
    if (active && now.getMinutes() === 0) {
      await sendStatusUpdate();
    }
  });
}

// ======================= INITIALIZATION =======================
async function init() {
  console.log('═══════════════════════════════════════════');
  console.log('🤖 TREND PULSE BOT - Node.js Version');
  console.log('═══════════════════════════════════════════');
  console.log(`📊 Monitoring: ${FOREX_ASSETS.join(', ')}`);
  console.log(`⏰ Session 1: 8:00 - 10:00 WAT (Mon-Fri)`);
  console.log(`⏰ Session 2: 13:00 - 18:00 WAT (Mon-Fri)`);
  console.log(`📡 Telegram Bot: ${BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE' ? 'CONFIGURED' : 'NOT SET'}`);
  console.log('═══════════════════════════════════════════\n');
  
  if (BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.log('[WARN] Please set your TELEGRAM_BOT_TOKEN environment variable');
    console.log('[WARN] Bot will run in simulation mode (no messages sent)');
  }
  
  // Send startup message
  await sendToChannel('🤖 *Trend Pulse Bot Started*\n\nMonitoring EUR/USD and GBP/USD\nSessions: 8:00-10:00 & 13:00-18:00 WAT (Mon-Fri)\n\n✅ Bot is live!', true);
  
  // Run initial analysis
  await runFullAnalysis();
  
  // Start schedulers
  startScheduledAnalysis();
  startSessionMonitor();
  
  console.log('[BOT] Active and monitoring...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[BOT] Shutting down gracefully...');
  sendToChannel('🛑 *Bot Shutdown*\n\nTrend Pulse bot has been stopped.', true);
  process.exit(0);
});

// Start the bot
init().catch(console.error);

// Keep process alive
setInterval(() => {
  // Heartbeat
}, 60000);
