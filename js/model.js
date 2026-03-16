// BXP Exposure Model - Calculates body load, debt, equivalents
// All based on WHO thresholds and clearance rate science

// Clearance rates (percent per hour)
const CLEARANCE_RATES = {
  pm25: 0.023,  // 2.3% per hour
  pm10: 0.020,  // 2.0% per hour
  no2: 0.45,    // 45% per hour
  o3: 0.12,     // 12% per hour
  so2: 0.40,    // 40% per hour
  co: 0.30,     // 30% per hour
  benzene: 0.15, // 15% per hour
  pb: 0.0001    // 0.01% per hour
};

// WHO 24-hour thresholds
const WHO_THRESHOLDS = {
  pm25: 15,
  pm10: 45,
  no2: 25,
  o3: 60,
  so2: 40,
  co: 4
};

// Severity weights
const SEVERITY_WEIGHTS = {
  pm25: 1.0,
  pm10: 0.6,
  no2: 0.7,
  o3: 0.8,
  so2: 0.5,
  co: 0.3,
  benzene: 0.9,
  pb: 0.95
};

// Main exposure model class
class ExposureModel {
  constructor(records = []) {
    this.records = records || [];
  }
  
  // Calculate current body load (0-100)
  calculateBodyLoad(now = new Date()) {
    if (!this.records || this.records.length === 0) return 0;
    
    const sorted = [...this.records].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    const loads = {};
    
    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i];
      if (!record || !record.timestamp) continue;
      
      const nextRecord = sorted[i + 1];
      
      const startTime = new Date(record.timestamp);
      const endTime = nextRecord ? new Date(nextRecord.timestamp) : now;
      const durationHours = (endTime - startTime) / (1000 * 60 * 60);
      
      if (durationHours <= 0 || !record.agents) continue;
      
      record.agents.forEach(agent => {
        if (!agent || !agent.parameter) return;
        
        const param = agent.parameter;
        const value = agent.value || 0;
        const rate = CLEARANCE_RATES[param] || 0.01;
        
        if (!loads[param]) loads[param] = 0;
        
        loads[param] += value * durationHours;
        loads[param] *= Math.exp(-rate * durationHours);
      });
    }
    
    let totalWeighted = 0;
    let totalWeight = 0;
    
    Object.keys(loads).forEach(param => {
      const weight = SEVERITY_WEIGHTS[param] || 0.5;
      const maxLoad = param === 'pm25' ? 100 : 50;
      const normalized = Math.min(loads[param] / maxLoad, 1) * 100;
      
      totalWeighted += normalized * weight;
      totalWeight += weight;
    });
    
    return Math.round(totalWeighted / totalWeight) || 0;
  }
  
  // Calculate exposure debt
  calculateDebt(now = new Date()) {
    if (!this.records || this.records.length === 0) {
      return { debtHours: 0, cleanAirNeeded: 0 };
    }
    
    const sorted = [...this.records].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    let debtHours = 0;
    
    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i];
      if (!record || !record.timestamp || !record.agents) continue;
      
      const nextRecord = sorted[i + 1];
      
      const startTime = new Date(record.timestamp);
      const endTime = nextRecord ? new Date(nextRecord.timestamp) : now;
      const durationHours = (endTime - startTime) / (1000 * 60 * 60);
      
      if (durationHours <= 0) continue;
      
      let exceeded = false;
      
      record.agents.forEach(agent => {
        if (!agent) return;
        const threshold = WHO_THRESHOLDS[agent.parameter];
        if (threshold && agent.value > threshold) {
          exceeded = true;
        }
      });
      
      if (exceeded) {
        debtHours += durationHours;
      }
    }
    
    const cleanAirNeeded = debtHours * 0.5;
    
    return {
      debtHours: Math.round(debtHours * 10) / 10,
      cleanAirNeeded: Math.round(cleanAirNeeded * 10) / 10
    };
  }
  
  // Get current PM2.5
  getCurrentPM25() {
    if (!this.records || this.records.length === 0) return 0;
    
    const latest = this.records[0];
    if (!latest || !latest.agents) return 0;
    
    const pm25 = latest.agents.find(a => a && a.parameter === 'pm25');
    return pm25 ? pm25.value || 0 : 0;
  }
  
  // Cigarette equivalent
  cigaretteEquivalent(pm25Value, hours = 1) {
    const total = (pm25Value || 0) * hours;
    return Math.round((total / 22) * 10) / 10;
  }
  
  // Find peaks
  findPeaks(records = this.records) {
    if (!records) return [];
    
    const peaks = [];
    
    records.forEach(record => {
      if (!record || !record.agents) return;
      
      record.agents.forEach(agent => {
        if (!agent) return;
        const threshold = WHO_THRESHOLDS[agent.parameter];
        if (threshold && agent.value > threshold * 1.5) {
          peaks.push({
            time: record.timestamp,
            parameter: agent.parameter,
            value: agent.value,
            threshold: threshold
          });
        }
      });
    });
    
    return peaks.sort((a, b) => b.value - a.value).slice(0, 3);
  }
  
  // Learn home and work locations
  learnLocations() {
    if (!this.records || this.records.length === 0) {
      return { home: null, work: null, homeConfidence: 0, workConfidence: 0 };
    }
    
    const locationByHour = {};
    
    this.records.forEach(record => {
      if (!record || !record.timestamp || !record.geohash) return;
      
      const date = new Date(record.timestamp);
      const hour = date.getHours();
      const geohash = record.geohash;
      
      if (!locationByHour[hour]) locationByHour[hour] = {};
      if (!locationByHour[hour][geohash]) locationByHour[hour][geohash] = 0;
      locationByHour[hour][geohash]++;
    });
    
    let homeGeohash = null;
    let homeConfidence = 0;
    
    const nightHours = [22, 23, 0, 1, 2, 3, 4, 5];
    nightHours.forEach(hour => {
      if (locationByHour[hour]) {
        const mostCommon = this._getMostCommon(locationByHour[hour]);
        if (mostCommon && mostCommon.count > homeConfidence) {
          homeGeohash = mostCommon.key;
          homeConfidence = mostCommon.count;
        }
      }
    });
    
    let workGeohash = null;
    let workConfidence = 0;
    const workLocations = {};
    
    this.records.forEach(record => {
      if (!record || !record.timestamp || !record.geohash) return;
      
      const date = new Date(record.timestamp);
      const day = date.getDay();
      const hour = date.getHours();
      const geohash = record.geohash;
      
      if (day >= 1 && day <= 5 && hour >= 9 && hour <= 17) {
        if (!workLocations[geohash]) workLocations[geohash] = 0;
        workLocations[geohash]++;
      }
    });
    
    const mostCommonWork = this._getMostCommon(workLocations);
    if (mostCommonWork) {
      workGeohash = mostCommonWork.key;
      workConfidence = mostCommonWork.count;
    }
    
    if (homeGeohash && workGeohash && homeGeohash === workGeohash) {
      workGeohash = null;
    }
    
    return {
      home: homeConfidence > 2 ? homeGeohash : null,
      work: workConfidence > 2 ? workGeohash : null,
      homeConfidence,
      workConfidence
    };
  }
  
  _getMostCommon(obj) {
    if (!obj) return null;
    
    let maxCount = 0;
    let maxKey = null;
    
    Object.keys(obj).forEach(key => {
      if (obj[key] > maxCount) {
        maxCount = obj[key];
        maxKey = key;
      }
    });
    
    return maxKey ? { key: maxKey, count: maxCount } : null;
  }
  
  getLocationAverage(geohash, parameter = 'pm25') {
    if (!this.records || !geohash) return null;
    
    const records = this.records.filter(r => r && r.geohash === geohash);
    if (records.length === 0) return null;
    
    let sum = 0;
    let count = 0;
    
    records.forEach(record => {
      if (!record.agents) return;
      const agent = record.agents.find(a => a && a.parameter === parameter);
      if (agent && agent.value) {
        sum += agent.value;
        count++;
      }
    });
    
    return count > 0 ? sum / count : null;
  }
}

// Make it global
window.ExposureModel = ExposureModel;