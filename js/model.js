// BXP Exposure Model - Calculates body load, debt, equivalents
// All based on WHO thresholds and clearance rate science

// Clearance rates (percent per hour)
// Each pollutant clears from body at different speeds
const CLEARANCE_RATES = {
  pm25: 0.023,  // 2.3% per hour - stays in lungs weeks
  pm10: 0.020,  // 2.0% per hour
  no2: 0.45,    // 45% per hour - clears in hours
  o3: 0.12,     // 12% per hour
  so2: 0.40,    // 40% per hour
  co: 0.30,     // 30% per hour
  benzene: 0.15, // 15% per hour
  pb: 0.0001    // 0.01% per hour - lead stays for years
};

// WHO 24-hour thresholds (safe limits)
const WHO_THRESHOLDS = {
  pm25: 15,     // µg/m³
  pm10: 45,     // µg/m³
  no2: 25,      // ppb
  o3: 60,       // ppb
  so2: 40,      // ppb
  co: 4         // ppm
};

// Severity weights for body load calculation
// How harmful each pollutant is relative to PM2.5
const SEVERITY_WEIGHTS = {
  pm25: 1.0,    // reference
  pm10: 0.6,    // less harmful
  no2: 0.7,     // similar
  o3: 0.8,      // very harmful
  so2: 0.5,     // moderate
  co: 0.3,      // less harmful
  benzene: 0.9, // carcinogenic
  pb: 0.95      // neurotoxic
};

// Main exposure model class
class ExposureModel {
  constructor(records = []) {
    this.records = records;
    this.cache = {};
  }
  
  // Calculate current body load (0-100)
  // This is how much pollution is currently in your body
  calculateBodyLoad(now = new Date()) {
    if (!this.records.length) return 0;
    
    // Sort oldest to newest
    const sorted = [...this.records].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    // Track current load for each pollutant
    const loads = {};
    
    // Process each record in order
    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i];
      const nextRecord = sorted[i + 1];
      
      const startTime = new Date(record.timestamp);
      const endTime = nextRecord ? new Date(nextRecord.timestamp) : now;
      
      // Duration this record applies (in hours)
      const durationHours = (endTime - startTime) / (1000 * 60 * 60);
      
      if (durationHours <= 0) continue;
      
      // For each pollutant in this record
      record.agents.forEach(agent => {
        const param = agent.parameter;
        const value = agent.value;
        const rate = CLEARANCE_RATES[param] || 0.01;
        
        if (!loads[param]) loads[param] = 0;
        
        // Add exposure during this period
        loads[param] += value * durationHours;
        
        // Apply clearance (exponential decay)
        loads[param] *= Math.exp(-rate * durationHours);
      });
    }
    
    // Normalize to 0-100
    let totalWeighted = 0;
    let totalWeight = 0;
    
    Object.keys(loads).forEach(param => {
      const weight = SEVERITY_WEIGHTS[param] || 0.5;
      
      // Rough max reasonable loads (normalization constants)
      const maxLoad = param === 'pm25' ? 100 : 50;
      
      // Normalize to 0-100
      const normalized = Math.min(loads[param] / maxLoad, 1) * 100;
      
      totalWeighted += normalized * weight;
      totalWeight += weight;
    });
    
    return Math.round(totalWeighted / totalWeight) || 0;
  }
  
  // Calculate exposure debt (hours above WHO limits)
  calculateDebt(now = new Date()) {
    if (!this.records.length) return { debtHours: 0, cleanAirNeeded: 0 };
    
    const sorted = [...this.records].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    let debtHours = 0;
    
    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i];
      const nextRecord = sorted[i + 1];
      
      const startTime = new Date(record.timestamp);
      const endTime = nextRecord ? new Date(nextRecord.timestamp) : now;
      const durationHours = (endTime - startTime) / (1000 * 60 * 60);
      
      if (durationHours <= 0) continue;
      
      // Check if any pollutant exceeded WHO limits
      let exceeded = false;
      
      record.agents.forEach(agent => {
        const threshold = WHO_THRESHOLDS[agent.parameter];
        if (threshold && agent.value > threshold) {
          exceeded = true;
        }
      });
      
      if (exceeded) {
        debtHours += durationHours;
      }
    }
    
    // Clean air needed (simplified: need half the debt time in clean air)
    const cleanAirNeeded = debtHours * 0.5;
    
    return {
      debtHours: Math.round(debtHours * 10) / 10,
      cleanAirNeeded: Math.round(cleanAirNeeded * 10) / 10
    };
  }
  
  // Convert PM2.5 to cigarette equivalents
  // One cigarette ≈ 22 µg/m³ PM2.5 per hour
  cigaretteEquivalent(pm25Value, hours = 1) {
    const totalExposure = pm25Value * hours;
    return Math.round((totalExposure / 22) * 10) / 10;
  }
  
  // Find peak exposure moments today
  findPeaks(records = this.records) {
    const peaks = [];
    
    records.forEach(record => {
      record.agents.forEach(agent => {
        const threshold = WHO_THRESHOLDS[agent.parameter];
        if (threshold && agent.value > threshold * 1.5) { // 50% above threshold
          peaks.push({
            time: record.timestamp,
            parameter: agent.parameter,
            value: agent.value,
            threshold: threshold
          });
        }
      });
    });
    
    // Sort by highest value
    return peaks.sort((a, b) => b.value - a.value).slice(0, 3);
  }
  
  // Get current PM2.5 from most recent record
  getCurrentPM25() {
    if (!this.records.length) return 0;
    
    const latest = this.records[0];
    const pm25 = latest.agents.find(a => a.parameter === 'pm25');
    return pm25 ? pm25.value : 0;
  }
}

// Make available globally
window.ExposureModel = ExposureModel;