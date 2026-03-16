// BXP Exposure - Main app logic
// Handles location, fetching air quality, updating UI

// Global variables
let model = null;
let updateInterval = null;

// Start when page loads
document.addEventListener('DOMContentLoaded', async () => {
  console.log('BXP Exposure starting...');
  
  // Open database
  await BXPLedger.openDB();
  
  // Check for location permission
  if ('geolocation' in navigator) {
    // Get current position immediately
    navigator.geolocation.getCurrentPosition(
      handleLocationUpdate,
      handleLocationError,
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
    
    // Watch for position changes
    navigator.geolocation.watchPosition(
      handleLocationUpdate,
      handleLocationError,
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000
      }
    );
    
  } else {
    showError('Geolocation not supported in this browser');
  }
  
  // Update UI every 60 seconds
  updateInterval = setInterval(updateUI, 60000);
  
  // Initial UI update
  await updateUI();
  
  // Set up export button
  document.getElementById('export-btn').addEventListener('click', () => {
    BXPLedger.exportAll();
  });
  
  // Clean up old records once a day
  setTimeout(() => {
    BXPLedger.cleanupOldRecords(30);
  }, 5000);
});

// Handle new location
async function handleLocationUpdate(position) {
  const { latitude, longitude, accuracy } = position.coords;
  
  console.log(`Location: ${latitude}, ${longitude} (${accuracy}m)`);
  
  // Create simple geohash (just rounded coordinates for now)
  const geohash = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  
  try {
    // Fetch air quality for this location
    const aqData = await fetchAirQuality(latitude, longitude);
    
    if (aqData.agents.length > 0) {
      // Create BXP record
      const record = {
        bxp_version: "2.0",
        timestamp: new Date().toISOString(),
        geohash: geohash,
        location_accuracy: accuracy,
        agents: aqData.agents,
        hri: calculateHRI(aqData.agents)
      };
      
      // Store in ledger
      await BXPLedger.addRecord(record);
      console.log('Record saved');
      
      // Update UI
      await updateUI();
    }
  } catch (error) {
    console.error('Error handling location:', error);
  }
}

function handleLocationError(error) {
  console.error('Location error:', error.message);
  
  let message = 'Location error';
  if (error.code === 1) {
    message = 'Location permission denied. Please enable to track exposure.';
  } else if (error.code === 2) {
    message = 'Location unavailable. Try again.';
  } else if (error.code === 3) {
    message = 'Location request timed out.';
  }
  
  showError(message);
}

// Fetch air quality from OpenAQ using CORS proxy
async function fetchAirQuality(lat, lon) {
  try {
    // Use a public CORS proxy to bypass OpenAQ restriction
    const proxyUrl = 'https://corsproxy.io/?';
    const targetUrl = `https://api.openaq.org/v2/latest?coordinates=${lat},${lon}&radius=10000&limit=1`;
    
    const response = await fetch(proxyUrl + encodeURIComponent(targetUrl));
    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      const location = data.results[0];
      
      const agents = location.measurements.map(m => ({
        parameter: m.parameter,
        value: m.value,
        unit: m.unit,
        source: 'openaq',
        quality: 'validated'
      }));
      
      return { agents };
    }
  } catch (error) {
    console.error('OpenAQ error:', error);
  }
  
  // Return empty if no data
  return { agents: [] };
}

// Simple HRI based on PM2.5 only
function calculateHRI(agents) {
  const pm25 = agents.find(a => a.parameter === 'pm25')?.value || 0;
  
  if (pm25 > 100) return 90;
  if (pm25 > 50) return 70;
  if (pm25 > 25) return 50;
  if (pm25 > 12) return 30;
  if (pm25 > 5) return 15;
  return 5;
}

// Update all UI elements
async function updateUI() {
  // Get today's records
  const todayRecords = await BXPLedger.getTodaysRecords();
  
  // Get recent records (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const recentRecords = await BXPLedger.getRecords({
    startDate: sevenDaysAgo.toISOString(),
    recent: true
  });
  
  // Create model with recent records
  model = new ExposureModel(recentRecords);
  
  // Update current status
  updateCurrentStatus(model, recentRecords);
  
  // Update today's summary
  updateTodaySummary(todayRecords, model);
  
  // Update history
  updateHistory(recentRecords);
  
  // NEW: Update location insights
  updateLocationInsights(model);
}

// NEW: Update home/work insights
function updateLocationInsights(model) {
  const locations = model.learnLocations();
  
  // Check if we already have a location card
  let locationCard = document.getElementById('location-insights');
  
  if (!locations.home && !locations.work) {
    // No locations learned yet, remove card if exists
    if (locationCard) locationCard.remove();
    return;
  }
  
  // Create or update card
  const mainElement = document.querySelector('main');
  
  if (!locationCard) {
    locationCard = document.createElement('div');
    locationCard.id = 'location-insights';
    locationCard.className = 'card';
    mainElement.insertBefore(locationCard, mainElement.children[2]); // After second card
  }
  
  let html = '<div class="card-title">Your places</div>';
  
  if (locations.home) {
    const homePM25 = model.getLocationAverage(locations.home);
    const homeDisplay = homePM25 ? `${homePM25.toFixed(1)} µg/m³` : 'learning...';
    html += `
      <div style="margin-bottom:1rem;">
        <strong>🏠 Home</strong><br>
        Average PM2.5: ${homeDisplay}
      </div>
    `;
  }
  
  if (locations.work) {
    const workPM25 = model.getLocationAverage(locations.work);
    const workDisplay = workPM25 ? `${workPM25.toFixed(1)} µg/m³` : 'learning...';
    
    // Compare with home if both exist
    if (locations.home) {
      const homePM25 = model.getLocationAverage(locations.home);
      if (homePM25 && workPM25) {
        const ratio = (workPM25 / homePM25).toFixed(1);
        const comparison = workPM25 > homePM25 
          ? `${ratio}x worse than home` 
          : `${(1/ratio).toFixed(1)}x better than home`;
        
        html += `
          <div style="margin-bottom:1rem;">
            <strong>💼 Work</strong><br>
            Average PM2.5: ${workDisplay}<br>
            <span style="font-size:0.8rem; color:var(--muted);">${comparison}</span>
          </div>
        `;
      } else {
        html += `
          <div style="margin-bottom:1rem;">
            <strong>💼 Work</strong><br>
            Average PM2.5: ${workDisplay}
          </div>
        `;
      }
    } else {
      html += `
        <div style="margin-bottom:1rem;">
          <strong>💼 Work</strong><br>
          Average PM2.5: ${workDisplay}
        </div>
      `;
    }
  }
  
  // Add confidence note
  if (locations.homeConfidence < 10) {
    html += `<div style="font-size:0.7rem; color:var(--muted2); margin-top:1rem;">Learning your patterns... (${Math.min(100, Math.round(locations.homeConfidence*10))}% confidence)</div>`;
  }
  
  locationCard.innerHTML = html;
}
  
  const bodyLoad = model.calculateBodyLoad();
  const debt = model.calculateDebt();
  const currentPM25 = model.getCurrentPM25();
  const cigaretteEq = model.cigaretteEquivalent(currentPM25);
  
  container.innerHTML = `
    <div class="status-grid">
      <div class="stat">
        <div class="stat-value">${bodyLoad}</div>
        <div class="stat-label">Body Load</div>
      </div>
      <div class="stat">
        <div class="stat-value">${debt.debtHours}h</div>
        <div class="stat-label">Exposure Debt</div>
      </div>
      <div class="stat">
        <div class="stat-value">${debt.cleanAirNeeded}h</div>
        <div class="stat-label">Clean Air Needed</div>
      </div>
    </div>
    <div class="equivalent">
      Current PM2.5: <span>${currentPM25} µg/m³</span><br>
      ≈ <span>${cigaretteEq} cigarettes/hour</span>
    </div>
  `;


// Update today's summary
function updateTodaySummary(records, model) {
  const container = document.getElementById('today-summary');
  
  if (!records || records.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; color:var(--muted);">
        No records today. Keep tab open.
      </div>
    `;
    return;
  }
  
  const peaks = model.findPeaks(records);
  const totalHours = records.length; // each record represents ~1 hour
  
  let peaksHtml = '';
  if (peaks.length > 0) {
    peaksHtml = '<div style="margin-top:1rem;"><strong>Peak moments:</strong><br>';
    peaks.forEach(p => {
      const time = new Date(p.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      peaksHtml += `${time} — ${p.parameter.toUpperCase()}: ${p.value} (${Math.round(p.value/p.threshold*100)}% above limit)<br>`;
    });
    peaksHtml += '</div>';
  }
  
  container.innerHTML = `
    <div><strong>${records.length}</strong> records today</div>
    ${peaksHtml}
  `;
}

// Update history list
async function updateHistory(records) {
  const container = document.getElementById('history-list');
  
  if (!records || records.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:1rem; color:var(--muted);">
        No records yet. Leave this tab open to start tracking.
      </div>
    `;
    return;
  }
  
  // Show last 10 records
  const recent = records.slice(0, 10);
  
  let html = '';
  recent.forEach(record => {
    const time = new Date(record.timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const pm25 = record.agents.find(a => a.parameter === 'pm25')?.value || '—';
    const hri = record.hri || '—';
    
    html += `
      <div class="history-item">
        <div>
          <span class="time">${time}</span>
        </div>
        <div style="display:flex; gap:1rem; align-items:center;">
          <span class="value">PM2.5: ${pm25}</span>
          <span class="hri">HRI ${hri}</span>
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

// Show error message
function showError(message) {
  const container = document.getElementById('current-status');
  container.innerHTML = `
    <div style="color:#c62828; padding:1rem; text-align:center;">
      ⚠️ ${message}
    </div>
  `;
}