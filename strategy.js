import Decimal from 'decimal.js';

export default class BidStrategy {
  constructor(api, priceMonitor, symbol) {
    this.api = api;
    this.priceMonitor = priceMonitor;
    this.symbol = symbol;
    this.initialPrice = null;
    this.isProcessing = false;
    this.emergencyMode = false;
    this.watchdogTimer = null;
    
    this.offsetPercentage = 0.0022; 
    this.changeThreshold_high = 0.004; 
    this.changeThreshold_low = 0.0012; 
    this.leverage = 40;
    this.availableBalance = 0;

    this.reorder = this.reorder.bind(this);
    this.checkAndClosePositions = this.checkAndClosePositions.bind(this);
    this.clearAllOpenOrders = this.clearAllOpenOrders.bind(this);
  }

  async checkAndClosePositions() {
    try {
      const posData = await Promise.race([
        this.api.queryPositions(this.symbol),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
      ]);

      const rawList = posData.result || posData.data || (Array.isArray(posData) ? posData : []);
      const finalItems = Array.isArray(rawList) ? rawList : (rawList.list || []);

      const activePositions = finalItems.filter(p => {
        const amount = new Decimal(String(p.qty || 0)).abs();
        return amount.gt(0) && p.symbol === this.symbol;
      });

      if (activePositions.length > 0) {
        for (const pos of activePositions) {
          const qty = new Decimal(String(pos.qty)).abs();
          const side = new Decimal(String(pos.qty)).gt(0) ? 'sell' : 'buy';
          
          console.error(`[EMERGENCY] 🚨 DETECTED! Qty: ${pos.qty} Side: ${side}. Closing...`);
          
          await this.clearAllOpenOrders();
          const res = await this.api.marketOrder(this.symbol, side, qty.toString());
          console.log(`[Risk] Market Close Success: ${JSON.stringify(res)}`);
          
          // 【核心修复】平仓后标记 initialPrice 为空，这样下一轮 reorder 就会立即执行
          this.initialPrice = null;
          await new Promise(r => setTimeout(r, 1000));
        }
        return true; 
      }
      return false; 
    } catch (e) {
      console.error('[Risk] ❌ Position Check Failed:', e.message);
      return false;
    }
  }

  // 计算和格式化逻辑保持不变
  calculateQty(price) {
    try {
      if (this.availableBalance <= 0) return 0;
      const qty = new Decimal(this.availableBalance).times(this.leverage).times(0.95).dividedBy(price);
      return (qty.toNumber() * 0.8).toFixed(3); 
    } catch (e) { return 0; }
  }

  formatPrice(price) {
    return new Decimal(price).times(new Decimal(1).minus(this.offsetPercentage)).toFixed(2);
  }

  async clearAllOpenOrders() {
    try {
      const openOrders = await this.api.queryOpenOrders(this.symbol);
      if (openOrders?.result?.length > 0) {
        const ids = openOrders.result.map(o => o.id);
        console.log(`[Strategy] 🗑️ Cleaning ${ids.length} residual orders...`);
        await this.api.cancelOrders(ids);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) { console.error('[Strategy] ❌ Clear failed:', e.message); }
  }

  async placeAndVerify(marketPrice) {
    const orderPrice = this.formatPrice(marketPrice);
    const qty = this.calculateQty(orderPrice);
    if(qty <= 0) {
        console.log(`[Strategy] 💰 Balance insufficient`);
        return false;
    }

    console.log(`[Strategy] 📝 Submitting: Qty ${qty} @ Price ${orderPrice} (Balance: ${this.availableBalance})`);
    try {
      const res = await this.api.newOrder(this.symbol, 'buy', 'limit', qty, orderPrice);
      if (res.code !== 0) {
        console.error(`[Strategy] ❌ Server Rejected: ${res.message}`);
        return false;
      }

      console.log(`[Strategy] 🔍 Verifying...`);
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 1500)); 
        const openOrders = await this.api.queryOpenOrders(this.symbol);
        if (openOrders.result?.some(o => new Decimal(String(o.price)).equals(orderPrice))) {
          console.log(`[Strategy] ✅ Order VERIFIED.`);
          console.log(`🎯[Live Range] 【${(orderPrice * (1 + this.changeThreshold_high)).toFixed(2)} ———— ${(orderPrice * (1 + this.changeThreshold_low)).toFixed(2)}】`);
          this.initialPrice = orderPrice;
          return true;
        }
      }
      return false;
    } catch (e) { return false; }
  }

  async reorder(marketPrice) {
    if (this.isProcessing || this.emergencyMode) return;
    this.isProcessing = true;

    console.log(`\n--- 🔄 Cycle Start (Market: ${marketPrice}) ---`);
    try {
      // 1. 检查并清理仓位
      const hadPosition = await this.checkAndClosePositions();
      
      // 2. 清理挂单
      await this.clearAllOpenOrders();
      await new Promise(r => setTimeout(r, 500)); 

      // 3. 刷新余额并下单
      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);

      const success = await this.placeAndVerify(marketPrice);
      if (!success) this.initialPrice = null;

    } catch (err) {
      console.error('[Strategy] Critical Loop Error:', err.message);
    } finally {
      this.isProcessing = false;
      console.log(`--- ✅ Cycle Finished ---\n`);
    }
  }

  startWatchdog() {
    this.watchdogTimer = setInterval(async () => {
      if (this.isProcessing) return; 

      const status = this.priceMonitor.getStatus();
      const isDead = (!status.isConnected && status.secondsSinceLastUpdate > 10) || status.secondsSinceLastUpdate > 30;

      if (isDead && !this.emergencyMode) {
        console.error(`[WATCHDOG] 🚨 Connection Lost! Lag: ${status.secondsSinceLastUpdate}s`);
        this.emergencyMode = true;
        await this.clearAllOpenOrders();
      } else if (!isDead && this.emergencyMode) {
        console.log('[WATCHDOG] 🟢 Recovered.');
        this.emergencyMode = false;
        this.initialPrice = null;
      }
      
      // 主动轮询仓位，如果发现仓位，触发一次 reorder 重新开始
      if (!this.isProcessing && !this.emergencyMode) {
        const found = await this.checkAndClosePositions();
        if (found) {
            console.log(`[Watchdog] 🛡️ Emergency clear done. Re-entering loop...`);
            await this.reorder(this.priceMonitor.getPrice());
        }
      }
    }, 5000); 
  }

  async start() {
    try {
      await this.checkAndClosePositions();
      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);
      console.log(`[Init] 💰 Available: ${this.availableBalance} U`);

      await this.api.changeLeverage(this.symbol, this.leverage);
      this.startWatchdog();

      this.priceMonitor.onPrice(async (p) => {
        if (this.emergencyMode || this.isProcessing) return;
        if (!this.initialPrice) {
          await this.reorder(p);
        } else {
          let diff = Math.abs((parseFloat(p / this.initialPrice) - 1));
          if (diff >= this.changeThreshold_high || diff <= this.changeThreshold_low) {
            console.log(`[Strategy] 🔄 Price Moved. Reordering...`);
            await this.reorder(p);
          }
        }
      });

      this.priceMonitor.onPosition(async (data) => {
        const qty = new Decimal(String(data.qty || 0)).abs();
        if (qty.gt(0) && !this.isProcessing) {
          console.warn(`[Risk] ⚠️ WS Alert! Position found: ${data.qty}`);
          // 这里的逻辑是：通过重置 initialPrice 并调用 reorder
          // reorder 内部会先跑 checkAndClosePositions 平仓，然后再挂新单
          this.initialPrice = null;
          await this.reorder(this.priceMonitor.getPrice());
        }
      });
    } catch (e) { console.error('[Strategy] 💀 Initialization Failed:', e.message); }
  }

  async stop() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    await this.checkAndClosePositions();
    await this.clearAllOpenOrders();
  }
}