import Decimal from 'decimal.js';

export default class BidStrategy {
  constructor(api, priceMonitor, symbol, side = 'long', leverage = 40) {
    this.api = api;
    this.priceMonitor = priceMonitor;
    this.symbol = symbol;
    this.side = side.toLowerCase(); 
    this.leverage = leverage; // 从 Redis 动态获取的杠杆

    this.initialPrice = null;
    this.isProcessing = false;
    this.emergencyMode = false;
    this.watchdogTimer = null;

    // 冷静期配置
    this.lastEmergencyTime = 0; 
    this.COOLDOWN_MS = 10 * 60 * 1000; // 10分钟
    
    // 策略参数
    this.offsetPercentage = 0.0022; 
    this.changeThreshold_high = 0.004; 
    this.changeThreshold_low = 0.0012; 
    this.availableBalance = 0;

    this.reorder = this.reorder.bind(this);
    this.checkAndClosePositions = this.checkAndClosePositions.bind(this);
    this.clearAllOpenOrders = this.clearAllOpenOrders.bind(this);
  }

  // 冷静期判定逻辑
  isInCooldown() {
    if (this.lastEmergencyTime === 0) return false;
    const elapsed = Date.now() - this.lastEmergencyTime;
    const remaining = this.COOLDOWN_MS - elapsed;
    
    if (remaining > 0) {
      if (Math.floor(elapsed / 1000) % 60 === 0) {
        console.log(`[Strategy] 🧊 Cooldown Active: ${(remaining / 1000 / 60).toFixed(1)} min remaining.`);
      }
      return true;
    }
    return false;
  }

  // 价格计算
  calculateOrderPrice(marketPrice) {
    const p = new Decimal(marketPrice);
    return this.side === 'short' 
      ? p.times(new Decimal(1).plus(this.offsetPercentage)).toFixed(2)
      : p.times(new Decimal(1).minus(this.offsetPercentage)).toFixed(2);
  }

  // 判定重挂区间
  shouldReorder(currentPrice) {
    if (!this.initialPrice) return true;
    const p = parseFloat(currentPrice);
    const i = parseFloat(this.initialPrice);
    const diff = p / i;

    if (this.side === 'short') {
      return (diff <= (1 - this.changeThreshold_high)) || (diff >= (1 - this.changeThreshold_low));
    } else {
      return Math.abs(diff - 1) >= this.changeThreshold_high || Math.abs(diff - 1) <= this.changeThreshold_low;
    }
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
          
          // 开启10分钟冷静期
          this.lastEmergencyTime = Date.now();
          this.initialPrice = null; 
          console.log(`[Strategy] 🧊 Cooldown started. Next order possible at: ${new Date(this.lastEmergencyTime + this.COOLDOWN_MS).toLocaleTimeString()}`);
          
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
    const orderPrice = this.calculateOrderPrice(marketPrice);
    const orderSide = this.side === 'short' ? 'sell' : 'buy';
    
    if (this.availableBalance <= 0) return false;
    // 使用动态杠杆计算数量
    const qty = new Decimal(this.availableBalance).times(this.leverage).times(0.95).dividedBy(orderPrice).times(0.8).toFixed(3);

    if (parseFloat(qty) <= 0) return false;

    console.log(`[Strategy] 📝 Submitting ${this.side.toUpperCase()}: Qty ${qty} @ Price ${orderPrice} (Lev: ${this.leverage}x)`);
    try {
      const res = await this.api.newOrder(this.symbol, orderSide, 'limit', qty, orderPrice);
      if (res.code !== 0) return false;

      console.log(`[Strategy] 🔍 Verifying...`);
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 1500)); 
        const openOrders = await this.api.queryOpenOrders(this.symbol);
        if (openOrders.result?.some(o => new Decimal(String(o.price)).equals(orderPrice))) {
          console.log(`[Strategy] ✅ ${this.side.toUpperCase()} Order VERIFIED.`);
          
          // 恢复 Live Range 打印
          const highBound = (new Decimal(orderPrice).times(1 + this.changeThreshold_high)).toFixed(2);
          const lowBound = (new Decimal(orderPrice).times(1 + this.changeThreshold_low)).toFixed(2);
          const shortHigh = (new Decimal(orderPrice).times(1 - this.changeThreshold_high)).toFixed(2);
          const shortLow = (new Decimal(orderPrice).times(1 - this.changeThreshold_low)).toFixed(2);
          
          if (this.side === 'short') {
            console.log(`🎯[Live Range] 【${shortHigh} ———— ${shortLow}】`);
          } else {
            console.log(`🎯[Live Range] 【${highBound} ———— ${lowBound}】`);
          }
          
          this.initialPrice = orderPrice;
          return true;
        }
      }
      return false;
    } catch (e) { return false; }
  }

  async reorder(marketPrice) {
    if (this.isProcessing || this.emergencyMode || this.isInCooldown()) return;
    this.isProcessing = true;
    console.log(`\n--- 🔄 Cycle Start (${this.side.toUpperCase()} @ Market: ${marketPrice}) ---`);
    try {
      await this.checkAndClosePositions();
      await this.clearAllOpenOrders();
      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);
      await this.placeAndVerify(marketPrice);
    } finally {
      this.isProcessing = false;
      console.log(`--- ✅ Cycle Finished ---\n`);
    }
  }

  async start() {
    try {
      await this.checkAndClosePositions();
      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);
      
      // 使用动态杠杆设置交易所杠杆
      await this.api.changeLeverage(this.symbol, this.leverage);
      console.log(`[Init] 💰 Available: ${this.availableBalance} U | Leverage set to ${this.leverage}x`);

      this.watchdogTimer = setInterval(async () => {
        if (!this.isProcessing) await this.checkAndClosePositions();
      }, 5000);

      this.priceMonitor.onPrice(async (p) => {
        if (this.isProcessing || this.emergencyMode || this.isInCooldown()) return;
        if (this.shouldReorder(p)) {
          if (this.initialPrice) console.log(`[Strategy] 🔄 Price moved. Reordering...`);
          await this.reorder(p);
        }
      });

      this.priceMonitor.onPosition(async (data) => {
        const qty = new Decimal(String(data.qty || 0)).abs();
        if (qty.gt(0)) {
          console.warn(`[Risk] ⚠️ WS Position Alert!`);
          this.initialPrice = null;
          await this.reorder(this.priceMonitor.getPrice());
        }
      });
    } catch (e) { console.error('Start Error:', e.message); }
  }

  async stop() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    await this.clearAllOpenOrders();
  }
}