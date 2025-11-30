const API_BASE_URL = 'https://your-backend/api/predict';
const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_FORECAST_DAYS = 540;
const API_HORIZON = 150;

let currentForecastData = null;
let currentCity = '';
let activeRequestId = 0;
const pendingRequests = new Map();

async function fetchWithDedup(url, options) {
  const key = url + JSON.stringify(options || {});

  if (pendingRequests.has(key)) {
    console.log('[DEDUP] Reusing pending request');
    return pendingRequests.get(key);
  }

  const promise = fetch(url, options)
    .then(res => res.json())
    .finally(() => pendingRequests.delete(key));

  pendingRequests.set(key, promise);
  return promise;
}

// date helpers
function isoLocalDate(d = new Date()) {
  return d.toLocaleDateString('en-CA');
}

function initializeDateInputs() {
  const todayStr = isoLocalDate(new Date());
  const max = new Date();
  max.setDate(max.getDate() + MAX_FORECAST_DAYS);
  const maxStr = isoLocalDate(max);

  const dateInput = document.getElementById('dateInput');
  if (dateInput) {
    dateInput.min = todayStr;
    dateInput.max = maxStr;
    dateInput.value = todayStr;
  }
}

// theme
function applyInitialTheme() {
  const savedTheme = localStorage.getItem('theme');
  const isDark = savedTheme !== 'light';
  document.body.classList.toggle('light-mode', !isDark);

  const themeToggle = document.querySelector('.theme-toggle');
  if (themeToggle) themeToggle.textContent = isDark ? '☀ Light Mode' : '🌙 Dark Mode';

  const isPlanner = localStorage.getItem('plannerMode') === 'true';
  document.body.classList.toggle('planner-mode', isPlanner);
  const warningsDiv = document.getElementById('plannerWarnings');
  if (warningsDiv) warningsDiv.classList.toggle('hidden', !isPlanner);
  const plannerToggle = document.querySelector('.planner-toggle');
  if (plannerToggle) plannerToggle.textContent = isPlanner ? '✅ Planner ON' : '📋 Planner Mode';

  document.body.classList.toggle('image-background', localStorage.getItem('backgroundType') === 'image');
}

// geocoding
async function getCoordinates(city) {
  const geoUrl = `${GEOCODING_API_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;

  try {
    const response = await fetch(geoUrl);
    if (!response.ok) throw new Error(`Geocoding HTTP Error Code: ${response.status}`);
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      const r = data.results[0];
      return { lat: parseFloat(r.latitude), lon: parseFloat(r.longitude) };
    }
    return null;
  } catch (error) {
    console.error('Geocoding API error:', error);
    throw new Error(`Geocoding Error: ${error.message}`);
  }
}

function determinePrecipitationType(forecast) {

  const mm = Number(forecast.precip_mm ?? 0);
  const p = Number(forecast.precip_prob ?? 0);
  const tmax = Number(forecast.tmax ?? 0);

  if (p < 35) return 'None';

  // Use API provided type if available and reliable, otherwise fallback to local logic
  // The API returns 'rain', 'snow', 'sleet', 'none'
  if (forecast.precip_type) {
    const typeMap = { 'rain': 'Rain', 'snow': 'Snow', 'sleet': 'Mixed', 'none': 'None' };
    return typeMap[forecast.precip_type] || 'None';
  }

  if (p < 30 || mm < 0.1) return 'None';
  if (tmax <= 2) return 'Snow';
  if (tmax <= 6) return 'Mixed';
  if (p >= 70) return 'Rain';
  return 'None';
}

// cache logic
function isCacheValid(isoDate) {
  if (!currentForecastData || !currentForecastData.cachedAt) return false;

  const cacheTime = new Date(currentForecastData.cachedAt).getTime();
  const now = new Date().getTime();
  const diffHours = (now - cacheTime) / (1000 * 60 * 60);

  const target = new Date(isoDate);
  const today = new Date(isoLocalDate());
  const daysDiff = (target - today) / (1000 * 60 * 60 * 24);

  // Gradual cache strategy
  if (daysDiff <= 3) return diffHours < 1; // Near term: 1 hour
  if (daysDiff <= 7) return diffHours < 3; // Mid term: 3 hours
  return diffHours < 6; // Long term: 6 hours
}

function updateCacheStatus(status) {
  // UI update removed for production cleanliness
  // Logic remains intact, just not visible to user
  /*
  const el = document.getElementById('cacheStatus');
  if (!el) return;

  if (status === 'HIT') {
    el.textContent = '⚡ Served from Cache';
    el.style.color = '#00E676';
  } else if (status === 'MISS') {
    el.textContent = '🌐 Fetched from API';
    el.style.color = '#2979FF';
  } else {
    el.textContent = '';
  }
  */
}

async function searchWeather(forceRefresh = false) {
  const cityInput = document.getElementById('cityInput');
  const dateInput = document.getElementById('dateInput');

  if (!cityInput || !dateInput) return;

  const city = cityInput.value.trim();
  const selectedISO = dateInput.value || isoLocalDate();

  if (!city) {
    showToast('Please enter a valid city name.', 'error');
    return;
  }

  // Cache check (updated to check .daily)
  if (!forceRefresh && currentCity && currentCity.toLowerCase() === city.toLowerCase() && currentForecastData && currentForecastData.daily) {
    if (isCacheValid(selectedISO)) {
      const cachedForecast = currentForecastData.daily.find(f => {
        // Updated to use .date
        return f.date === selectedISO;
      });

      if (cachedForecast) {
        console.log(`[CACHE] HIT`);
        updateCacheStatus('HIT');
        updateUI(city, selectedISO, cachedForecast);
        return;
      }
    }
  }

  updateCacheStatus('MISS');
  const requestId = ++activeRequestId;
  console.log(`[REQUEST] #${requestId} for ${city}`);

  try {
    const location = await getCoordinates(city);

    if (requestId !== activeRequestId) return;
    if (!location) {
      showToast(`Coordinates for "${city}" not found.`, 'error');
      return;
    }

    const todayISO = isoLocalDate(new Date());
    const leadDays = Math.ceil((new Date(selectedISO + 'T00:00:00') - new Date(todayISO + 'T00:00:00')) / (24 * 3600 * 1000));
    let horizon = API_HORIZON;
    if (leadDays >= 0) horizon = Math.max(API_HORIZON, leadDays + 1);

    const requestData = {
      lat: location.lat,
      lon: location.lon,
      target_date: selectedISO.replace(/-/g, ''),
      horizon_days: horizon
    };

    const rawData = await fetchWithDedup(API_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData)
    });

    if (requestId !== activeRequestId) return;

    // Updated: rawData.daily
    const forecastList = rawData.daily || [];
    currentForecastData = {
      daily: forecastList, // Updated key
      cachedAt: new Date().toISOString(),
      cityName: city
    };
    currentCity = city;

    const targetForecast = forecastList.find(f => {
      // Updated: f.date
      return f.date === selectedISO;
    });

    if (targetForecast) {
      updateUI(city, selectedISO, targetForecast);
    } else {
      showToast('Selected date is out of range.', 'warning');
    }

  } catch (error) {
    console.error('Error:', error);
    showToast(`An error occurred: ${error.message}`, 'error');
  }
}

function refreshForecast() {
  console.log('[UI] Manual refresh');
  searchWeather(true);
}

// UI updates
function updateUI(city, isoDate, forecast) {
  const emptyState = document.getElementById('emptyState');
  const weatherData = document.getElementById('weatherData');

  if (emptyState) emptyState.style.display = 'none';
  if (weatherData) weatherData.style.display = 'block';

  document.getElementById('cityName').textContent = city;
  document.getElementById('selectedDate').textContent = new Date(isoDate).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  updateWeatherCard(forecast);
  updatePlannerWarnings(forecast);
}

function updateWeatherCard(forecast, customDesc = null) {
  if (forecast.tmax === '...' || forecast.tmax === undefined) {
    document.getElementById('temperature').textContent = '...°C';
    document.getElementById('weatherDesc').textContent = customDesc || 'Loading...';
    document.getElementById('precipitation').textContent = '- %';
    document.getElementById('precipitationType').textContent = '-';
    return;
  }

  const temp = (forecast.tmax !== 'Error') ? `${Math.round(forecast.tmax)}°C` : 'ERROR';
  document.getElementById('temperature').textContent = temp;

  const weatherDescElement = document.getElementById('weatherDesc');
  const oldBadge = weatherDescElement.querySelector('.data-source-badge');
  if (oldBadge) oldBadge.remove();

  // Use backend provided description if available, otherwise fallback
  let desc = customDesc || forecast.weather_desc || 'Partly Cloudy';
  weatherDescElement.textContent = desc;

  // Updated: precip_prob
  document.getElementById('precipitation').textContent = `${forecast.precip_prob ?? '-'}%`;

  const precipitationType = determinePrecipitationType(forecast);
  document.getElementById('precipitationType').textContent = precipitationType;
}

// toggles
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  const themeToggle = document.querySelector('.theme-toggle');
  if (themeToggle) themeToggle.textContent = isLight ? '🌙 Dark Mode' : '☀ Light Mode';
}

function togglePlanner() {
  const isPlanner = document.body.classList.toggle('planner-mode');
  const warnings = document.getElementById('plannerWarnings');
  warnings.classList.toggle('hidden', !isPlanner);
  localStorage.setItem('plannerMode', isPlanner);
  const plannerToggle = document.querySelector('.planner-toggle');
  if (plannerToggle) plannerToggle.textContent = isPlanner ? '✅ Planner ON' : '📋 Planner Mode';

  if (isPlanner && currentForecastData) {
    const selectedISO = document.getElementById('dateInput').value || isoLocalDate();
    // Updated: daily and date
    const targetForecast = (currentForecastData.daily || []).find(
      f => f.date === selectedISO
    );
    if (targetForecast) updatePlannerWarnings(targetForecast);
  }
}

// toast notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  toast.innerHTML = `
    <span class="toast-message">${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;

  container.appendChild(toast);

  // Auto remove after 4 seconds
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease-out forwards';
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 4000);
}

// Global assignment
window.showToast = showToast;

// favorites
function loadFavorites() {
  const favorites = JSON.parse(localStorage.getItem('novaPulseFavorites')) || [];
  const container = document.getElementById('favoriteCities');
  if (!container) return;

  container.innerHTML = '';

  if (favorites.length === 0) {
    container.innerHTML = '<p class="no-favorites">No favorites yet</p>';
    return;
  }

  favorites.forEach(city => {
    const cityDiv = document.createElement('div');
    cityDiv.className = 'favorite-city-item';
    cityDiv.innerHTML = `
      <span onclick="selectFavorite('${city}')">${city}</span>
      <button onclick="removeFavorite('${city}')" class="remove-btn">×</button>
    `;
    container.appendChild(cityDiv);
  });
}

function addToFavorites() {
  if (!currentCity) {
    showToast('Please search for a city first', 'error');
    return;
  }

  let favorites = JSON.parse(localStorage.getItem('novaPulseFavorites')) || [];
  if (!favorites.includes(currentCity)) {
    favorites.push(currentCity);
    localStorage.setItem('novaPulseFavorites', JSON.stringify(favorites));
    loadFavorites();
    showToast(`${currentCity} added to favorites!`, 'success');
  } else {
    showToast(`${currentCity} already in favorites`, 'info');
  }
}

function selectFavorite(city) {
  const cityInput = document.getElementById('cityInput');
  if (cityInput) {
    cityInput.value = city;
    searchWeather();
  }
}

function removeFavorite(cityToRemove) {
  let favorites = JSON.parse(localStorage.getItem('novaPulseFavorites')) || [];
  favorites = favorites.filter(city => city !== cityToRemove);
  localStorage.setItem('novaPulseFavorites', JSON.stringify(favorites));
  loadFavorites();
}

// planner warnings
function updatePlannerWarnings(forecast) {
  const container = document.getElementById('warningsContainer');
  if (!container) return;

  container.innerHTML = '';
  const warnings = [];
  const currentPrecipType = determinePrecipitationType(forecast);

  if (Number(forecast.tmax) >= 25) {
    warnings.push({ text: "Sunscreen recommended (High temp)", level: 'success' });
  }

  // updated: precip_prob
  const p = Number(forecast.precip_prob ?? 0);
  if (p >= 80) {
    warnings.push({ text: "High precipitation! Bring umbrella ☔", level: 'danger' });
  }

  if (currentPrecipType === 'Snow' || currentPrecipType === 'Mixed') {
    warnings.push({ text: "Winter conditions - check roads", level: 'warning' });
  } else if (p < 30 && currentPrecipType === 'None') {
    warnings.push({ text: "Perfect day for outdoor activities! ☀", level: 'success' });
  }

  if (warnings.length === 0) {
    container.innerHTML = '<p class="no-warning">No warnings. Have a great day!</p>';
  } else {
    warnings.forEach(w => {
      const el = document.createElement('div');
      el.className = `warning-item warning-level-${w.level}`;
      el.innerHTML = `<div class="warning-title">${w.level.toUpperCase()}</div>${w.text}`;
      container.appendChild(el);
    });
  }
}

// initialization
document.addEventListener('DOMContentLoaded', () => {
  applyInitialTheme();
  initializeDateInputs();
  loadFavorites();

  // initial Empty State Check
  const emptyState = document.getElementById('emptyState');
  const weatherData = document.getElementById('weatherData');
  if (emptyState && weatherData) {
    emptyState.style.display = 'block';
    weatherData.style.display = 'none';
  }

  showStartupPopup();
});

// startup popup
function showStartupPopup() {

  if (localStorage.getItem('startupPopupSeen')) return;

  const popupOverlay = document.createElement('div');
  popupOverlay.className = 'popup-overlay';
  popupOverlay.innerHTML = `
    <div class="popup-content">
      <div class="popup-icon">🚀</div>
      <div class="popup-title">Welcome to NovaCast!</div>
      <div class="popup-text">
        Since our AI models run on a free tier server, the first prediction might take up to <strong>1 minute</strong> to wake up the system (Cold Start).<br><br>
        Please be patient, subsequent requests will be much faster! ⚡
      </div>
      <button class="popup-close-btn" onclick="closeStartupPopup(this)">Got it, thanks!</button>
    </div>
  `;
  document.body.appendChild(popupOverlay);
}

function closeStartupPopup(btn) {
  const overlay = btn.closest('.popup-overlay');
  if (overlay) {
    overlay.style.animation = 'fadeOut 0.3s ease-out forwards';
    overlay.addEventListener('animationend', () => {
      overlay.remove();
      localStorage.setItem('startupPopupSeen', 'true');
    });
  }
}

// global window assignments
window.searchWeather = searchWeather;
window.refreshForecast = refreshForecast;
window.toggleTheme = toggleTheme;
window.togglePlanner = togglePlanner;
window.addToFavorites = addToFavorites;
window.selectFavorite = selectFavorite;
window.removeFavorite = removeFavorite;
window.closeStartupPopup = closeStartupPopup;

