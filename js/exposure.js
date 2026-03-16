// BXP Exposure - SIMPLIFIED TEST VERSION

document.addEventListener('DOMContentLoaded', () => {
  console.log('Test version started');
  
  // Simple location test
  if (navigator.geolocation) {
    console.log('Geolocation available');
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        console.log('SUCCESS! Got location:', position.coords);
        document.getElementById('current-status').innerHTML = `
          <div style="color:green; padding:1rem;">
            ✅ Location working!<br>
            Lat: ${position.coords.latitude}<br>
            Lon: ${position.coords.longitude}
          </div>
        `;
      },
      (error) => {
        console.error('Location error:', error);
        let message = 'Location failed: ';
        if (error.code === 1) message += 'Permission denied';
        else if (error.code === 2) message += 'Position unavailable';
        else if (error.code === 3) message += 'Timeout';
        else message += error.message;
        
        document.getElementById('current-status').innerHTML = `
          <div style="color:red; padding:1rem;">
            ❌ ${message}
          </div>
        `;
      },
      {
        enableHighAccuracy: false,
        timeout: 30000,
        maximumAge: 60000
      }
    );
  } else {
    document.getElementById('current-status').innerHTML = `
      <div style="color:red; padding:1rem;">
        ❌ Geolocation not supported
      </div>
    `;
  }
});