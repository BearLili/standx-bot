import { initRedis, getConfig, closeRedis } from './config.js';
import { authenticate } from './auth.js';
import StandXAPI from './api.js';
import PriceMonitor from './ws.js';
import BidStrategy from './strategy.js';

async function main() {
  let priceMonitor;
  let strategy;
  let isCleaningUp = false;

  const emergencyCleanup = async (reason) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.log(`\n[System] Shutdown: ${reason}`);
    try {
      if (strategy) await strategy.stop();
      if (priceMonitor) priceMonitor.close();
      await closeRedis();
      console.log('[System] Safe Exit.');
    } catch (e) {
      console.error('[System] Cleanup Error:', e.message);
    } finally {
      process.exit(reason === 'error' ? 1 : 0);
    }
  };

  process.on('SIGINT', () => emergencyCleanup('SIGINT'));
  process.on('SIGTERM', () => emergencyCleanup('SIGTERM'));
  process.on('unhandledRejection', (e) => emergencyCleanup('error'));
  process.on('uncaughtException', (e) => emergencyCleanup('error'));

  try {
    await initRedis(process.env.REDIS_HOST || 'localhost', process.env.REDIS_PORT || 6379);
    const accountKey = process.env.ACCOUNT_KEY || 'standx:account:1';
    const config = await getConfig(accountKey);

    if (!config) throw new Error('Config not found');
    const { chain, walletAddress, privateKey, symbol = 'BTC-USD', proxy = null } = config;

    console.log(`[Main] Authenticating ${walletAddress}...`);
    const authData = await authenticate(chain, walletAddress, privateKey);

    const api = new StandXAPI(authData.token, authData.signingKey, authData.requestId, proxy);
    
    priceMonitor = new PriceMonitor(symbol, proxy);
    await priceMonitor.connect();

    strategy = new BidStrategy(api, priceMonitor, symbol);
    await strategy.start();

    console.log('✅ Bot running. Ctrl+C to exit.');
    setInterval(() => {}, 1000);

  } catch (error) {
    console.error('Startup Error:', error.message);
    await emergencyCleanup('error');
  }
}

main();