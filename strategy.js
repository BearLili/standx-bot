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
    
    // 策略参数
    this.offsetPercentage = 0.0022; // 0.25%
    this.changeThreshold_high = 0.004  // 0.4%
    this.changeThreshold_low = 0.0012;  // 0.12%
    this.leverage = 40;
    this.availableBalance = 0;     // 实时余额
  }

  // 1. 动态计算数量: (可用余额 * 杠杆 * 0.95安全系数) / 价格
  calculateQty(price) {
    try {
      if (this.availableBalance <= 0) return 0;
      const qty = new Decimal(this.availableBalance)
        .times(this.leverage)
        .times(0.95) // 预留 5% 防止手续费或价格波动导致保证金不足
        .dividedBy(price);
      
      // BTC 通常保留 3 位小数，根据交易对调整
      return (qty * 0.8).toFixed(3); // 保留 80% 的可用余额
    } catch (e) {
      return 0;
    }
  }

  formatPrice(price) {
    return new Decimal(price).times(new Decimal(1).minus(this.offsetPercentage)).toFixed(2);
  }

  async clearAllOpenOrders() {
    try {
      const openOrders = await this.api.queryOpenOrders(this.symbol);
      if (openOrders && openOrders.result && openOrders.result.length > 0) {
        const ids = openOrders.result.map(o => o.id);
        console.log(`[Strategy] 🗑️ Cleaning ${ids.length} residual orders...`);
        await this.api.cancelOrders(ids);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) {
      console.error('[Strategy] ❌ Clear failed:', e.message);
    }
  }

  /**
   * 核心：下单并去链上核实
   */
  async placeAndVerify(marketPrice) {
    const orderPrice = this.formatPrice(marketPrice);
    const qty = this.calculateQty(orderPrice);
    if(qty <= 0) {
      console.log(`[Strategy] 💰 No available balance to place order`);
      return false;
    }
    console.log(`[Strategy] 📝 Submitting: Qty ${qty} @ Price ${orderPrice} (Balance: ${this.availableBalance})`);
    
    try {
      const res = await this.api.newOrder(this.symbol, 'buy', 'limit', qty, orderPrice);
      
      if (res.code !== 0) {
        console.error(`[Strategy] ❌ Server rejected: ${res.message}`);
        return false;
      }

      // 关键：下单后循环检查 3 次，看 Open Orders 里有没有
      console.log(`[Strategy] 🔍 Verifying order status on-chain...`);
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 1500)); 
        const openOrders = await this.api.queryOpenOrders(this.symbol);
        const found = openOrders.result?.some(o => new Decimal(o.price).equals(orderPrice));
        
        if (found) {
          console.log(`[Strategy] ✅ Order VERIFIED in orderbook.`);
          console.log(`🎯[Live Range] 【${(orderPrice * (1 + this.changeThreshold_high)).toFixed(2)} ———— ${(orderPrice * (1 + this.changeThreshold_low)).toFixed(2)}】`);
          this.initialPrice = orderPrice;
          return true;
        }
        console.log(`[Strategy] ⏳ Attempt ${i+1}: Order not found yet...`);
      }
      
      console.error(`[Strategy] 💀 FATAL: Order reported success but NOT found in open orders. (Insufficient margin?)`);
      return false;
    } catch (e) {
      console.error(`[Strategy] ❌ Exception during placement:`, e.message);
      return false;
    }
  }

  async reorder(marketPrice) {
    if (this.isProcessing || this.emergencyMode) return;
    this.isProcessing = true;

    console.log(`\n--- 🔄 Cycle Start (Market: ${marketPrice}) ---`);
    try {
      await this.clearAllOpenOrders();
      await new Promise(r => setTimeout(r, 500)); 

      // 每次下单前重新获取一次余额，确保计算准确
      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);

      const success = await this.placeAndVerify(marketPrice);
      
      if (!success) {
        console.log('[Strategy] ⚠️ Cycle failed. Resetting for next price movement.');
        this.initialPrice = null; // 重置，允许下个价格推送重新尝试
      }
    } finally {
      this.isProcessing = false;
      console.log(`--- ✅ Cycle Finished ---\n`);
    }
  }

  startWatchdog() {
    this.watchdogTimer = setInterval(async () => {
      const status = this.priceMonitor.getStatus();
      const isDead = (!status.isConnected && status.secondsSinceLastUpdate > 5) || status.secondsSinceLastUpdate > 15;

      if (isDead && !this.emergencyMode) {
        console.error(`[WATCHDOG] 🚨 Connection Lost! Lag: ${status.secondsSinceLastUpdate}s`);
        this.emergencyMode = true;
        await this.clearAllOpenOrders();
      } else if (!isDead && this.emergencyMode) {
        this.emergencyMode = false;
        this.initialPrice = null;
      }
    }, 2000);
  }

  async start() {
    try {
      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);
      console.log(`[Init] 💰 Available: ${this.availableBalance} U`);

      await this.api.changeLeverage(this.symbol, this.leverage);
      this.startWatchdog();

      this.priceMonitor.onPrice(async (p) => {
        if (this.emergencyMode) return;
        if (!this.initialPrice) {
          await this.reorder(p);
        } else {
          if(!p || !this.initialPrice) return;
          let diff = Math.abs((parseFloat(p / this.initialPrice) - 1).toFixed(4));
          if (diff >= this.changeThreshold_high || diff <= this.changeThreshold_low) {
            console.log(`[Strategy] 🔄 Price changed: ${diff}`);
            console.log(`[Strategy] 🔄 Current price: ${p} / Order price: ${this.initialPrice}`);
            await this.reorder(p);
          }
        }
      });
    } catch (e) {
      console.error('[Strategy] 💀 Start Error:', e.message);
    }
  }

  async stop() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    await this.clearAllOpenOrders();
  }
}