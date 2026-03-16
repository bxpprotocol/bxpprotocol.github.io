// BXP Exposure - WITH IP FALLBACK

document.addEventListener('DOMContentLoaded', () => {
  console.log('Starting with IP fallback');
  
  // Try GPS first
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      // Success
      (position) => {
        console.log('GPS success:', position.coords);
        showLocation('gps', position.coords.latitude, position.coords.longitude);
      },
      // GPS Failed - try IP
      (error) => {
        console.log('GPS failed, trying IP:', error.message);
        getLocationFromIP();
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000
      }
    );
  } else {
    // No GPS at all - try IP
    getLocationFromIP();
  }
});

// Get location from IP address
async function getLocationFromIP() {
  try {
    // Free IP geolocation API
    const response = await fetch('https://ipapi.co/json/');
    const data = await response.json();
    
    if (data.latitude && data.longitude) {
      console.log('IP location:', data);
      showLocation('ip', data.latitude, data.longitude, data.city);
    } else {
      showError('Could not get location from IP');
    }
  } catch (error) {
    console.error('IP location failed:', error);
    showError('All location methods failed');
  }
}

// Show location on page
function showLocation(method, lat, lon, city = '') {
  const statusDiv = document.getElementById('current-status');
  
  let locationText = `📍 Location (${method}): ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  if (city) locationText += ` - ${city}`;
  
  statusDiv.innerHTML = `
    <div style="padding:1rem;">
      <div style="color:green; font-weight:bold; margin-bottom:0.5rem;">✅ Location working!</div>
      <div>${locationText}</div>
      <div style="margin-top:1rem; font-size:0.8rem; color:var(--muted);">
        Now we can fetch air quality data...
      </div>
    </div>
  `;
}

function showError(message) {
  document.getElementById('current-status').innerHTML = `
    <div style="color:#c62828; padding:1rem; text-align:center;">
      ⚠️ ${message}
    </div>
  `;
}