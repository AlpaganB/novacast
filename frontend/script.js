const API_BASE_URL = 'https://your-backend/api/predict';
const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_FORECAST_DAYS = 540;
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

// Date helpers
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

        // NEW: Make the whole input clickable to show picker
        dateInput.addEventListener('click', function () {
            try {
                this.showPicker();
            } catch (e) {
                console.log('showPicker not supported');
            }
        });
    }
}

// Theme
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

// Geocoding - Enhanced with smarter matching
async function getCoordinates(city) {
    const geoUrl = `${GEOCODING_API_URL}?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;

    // Normalize Turkish characters for comparison
    const normalize = (str) => str.toLowerCase()
        .replace(/İ/g, 'i').replace(/I/g, 'i')
        .replace(/ı/g, 'i').replace(/i̇/g, 'i')
        .replace(/ş/g, 's').replace(/ç/g, 'c')
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o')
        .trim();

    try {
        const response = await fetch(geoUrl);
        if (!response.ok) throw new Error(`Geocoding HTTP Error Code: ${response.status}`);
        const data = await response.json();

        if (data.results && data.results.length > 0) {
            const searchNorm = normalize(city);

            // Priority 1: Exact name match (normalized)
            let match = data.results.find(r => normalize(r.name) === searchNorm);

            // Priority 2: Find the SHORTEST name that starts with search term
            // This prevents "İzmirli" matching when "İzmir" exists
            if (!match) {
                const startsWithMatches = data.results.filter(r =>
                    normalize(r.name).startsWith(searchNorm)
                );
                if (startsWithMatches.length > 0) {
                    // Pick the shortest one (most likely the actual city)
                    startsWithMatches.sort((a, b) => a.name.length - b.name.length);
                    match = startsWithMatches[0];
                }
            }

            // Priority 3: Search term is in name (find shortest)
            if (!match) {
                const includesMatches = data.results.filter(r =>
                    normalize(r.name).includes(searchNorm)
                );
                if (includesMatches.length > 0) {
                    includesMatches.sort((a, b) => a.name.length - b.name.length);
                    match = includesMatches[0];
                }
            }

            // Fallback: First result
            if (!match) {
                console.warn(`[GEO] No match for "${city}", using first result: ${data.results[0].name}`);
                match = data.results[0];
            }

            console.log(`[GEO] Resolved "${city}" → ${match.name} (${match.country || 'Unknown'})`);

            // Proper capitalization with Turkish support
            const capitalize = (str) => {
                // Handle Turkish: i → İ (not I)
                const first = str.charAt(0);
                const upper = first === 'i' ? 'İ' : first.toUpperCase();
                return upper + str.slice(1).toLowerCase();
            };

            // Use capitalized version of user input if it matches
            const displayName = (normalize(city) === normalize(match.name))
                ? capitalize(city.trim())
                : match.name;

            return {
                lat: parseFloat(match.latitude),
                lon: parseFloat(match.longitude),
                resolvedName: displayName,
                country: match.country
            };
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

// Cache logic
// Cache logic
function isCacheValid() {
    if (!currentForecastData || !currentForecastData.expiresAt) return false;
    return Date.now() < currentForecastData.expiresAt;
}

function updateCacheStatus(status) {
    // For testing **
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
        showToast(currentLang === 'tr' ? 'Lütfen geçerli bir şehir adı girin.' : 'Please enter a valid city name.', 'error');
        return;
    }

    // Cache check (updated to check .daily)
    // Cache check
    if (!forceRefresh && currentCity && currentCity.toLowerCase() === city.toLowerCase() && currentForecastData && currentForecastData.daily) {
        if (isCacheValid()) {
            const cachedForecast = currentForecastData.daily.find(f => {
                return f.date === selectedISO;
            });

            if (cachedForecast) {
                console.log(`[CACHE] HIT (Expires in ${Math.round((currentForecastData.expiresAt - Date.now()) / 60000)} mins)`);
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
            showToast(currentLang === 'tr' ? `"${city}" için koordinatlar bulunamadı.` : `Coordinates for "${city}" not found.`, 'error');
            return;
        }

        const todayISO = isoLocalDate(new Date());
        const leadDays = Math.ceil((new Date(selectedISO + 'T00:00:00') - new Date(todayISO + 'T00:00:00')) / (24 * 3600 * 1000));
        // Dynamic horizon (fetch up to the selected date + buffer (45 days))
        const BUFFER_DAYS = 45;
        let horizon = leadDays + BUFFER_DAYS;

        // Ensure minimum day (30) and maximum limit (MAX_FORECAST_DAYS)
        if (horizon < 30) horizon = 30;
        if (horizon > MAX_FORECAST_DAYS) horizon = MAX_FORECAST_DAYS;

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

        // Updated rawData.daily
        const forecastList = rawData.daily || [];
        const ttl = rawData.meta && rawData.meta.ttl_seconds ? rawData.meta.ttl_seconds : 3600;

        currentForecastData = {
            daily: forecastList,
            expiresAt: Date.now() + (ttl * 1000), // Calculate absolute expiration time
            cityName: location.resolvedName || city
        };
        currentCity = location.resolvedName || city;

        const targetForecast = forecastList.find(f => {
            // Updated f.date
            return f.date === selectedISO;
        });

        if (targetForecast) {
            updateUI(location.resolvedName || city, selectedISO, targetForecast);
        } else {
            const availableDates = forecastList.map(f => f.date);
            const rangeStart = availableDates[0] || 'N/A';
            const rangeEnd = availableDates[availableDates.length - 1] || 'N/A';

            if (forecastList.length === 0) {
                console.error(`[ERROR] Empty forecast list received for ${city}`);
                showToast(currentLang === 'tr'
                    ? `"${city}" için tahmin verisi alınamadı. Lütfen tekrar deneyin.`
                    : `Could not retrieve forecast data for "${city}". Please try again.`, 'error');
            } else {
                console.warn(`[ERROR] Date ${selectedISO} not found in forecast list.`);
                console.warn(`[DEBUG] Received ${forecastList.length} days. Range: ${rangeStart} to ${rangeEnd}`);
                showToast(currentLang === 'tr'
                    ? `Seçilen tarih (${selectedISO}) aralık dışında. Mevcut: ${rangeStart} - ${rangeEnd}`
                    : `Selected date (${selectedISO}) is out of range. Available: ${rangeStart} to ${rangeEnd}`, 'warning');
            }
        }

    } catch (error) {
        console.error('Error:', error);
        showToast(currentLang === 'tr' ? `Bir hata oluştu: ${error.message}` : `An error occurred: ${error.message}`, 'error');
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

    // Date Translation
    let dateStr = isoDate;
    if (isoDate) {
        const d = new Date(isoDate);
        dateStr = d.toLocaleDateString(currentLang === 'tr' ? 'tr-TR' : 'en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
    }
    document.getElementById('selectedDate').textContent = dateStr;
    updateWeatherCard(forecast);
    updatePlannerWarnings(forecast);
}

function updateWeatherCard(forecast, customDesc = null) {
    if (forecast.tmax === '...' || forecast.tmax === undefined) {
        document.getElementById('temperature').textContent = '...°C';
        document.getElementById('tempLow').textContent = '...';
        document.getElementById('weatherDesc').textContent = customDesc || (currentLang === 'tr' ? 'Yükleniyor...' : 'Loading...');
        document.getElementById('precipitation').textContent = '- %';
        document.getElementById('precipitationType').textContent = '-';
        return;
    }

    const temp = (forecast.tmax !== 'Error') ? `${Math.round(forecast.tmax)}°C` : 'ERROR';
    document.getElementById('temperature').textContent = temp;

    // NEW: TMIN Display with Translation
    if (forecast.tmin !== undefined && forecast.tmin !== null) {
        const nightLabel = currentLang === 'tr' ? 'Gece' : 'Night';
        document.getElementById('tempLow').textContent = `${nightLabel}: ${Math.round(forecast.tmin)}°C`;
    } else {
        document.getElementById('tempLow').textContent = '';
    }

    const weatherDescElement = document.getElementById('weatherDesc');
    const oldBadge = weatherDescElement.querySelector('.data-source-badge');
    if (oldBadge) oldBadge.remove();

    // Use backend provided description if available, otherwise fallback
    let desc = customDesc || forecast.weather_desc || (currentLang === 'tr' ? 'Parçalı Bulutlu' : 'Partly Cloudy');

    // Translation Logic
    const map = weatherMaps[currentLang];
    if (map) {
        // Exact match
        if (map[desc]) {
            desc = map[desc];
        } else {
            // Partial match
            Object.keys(map).forEach(key => {
                if (desc.includes(key)) desc = desc.replace(key, map[key]);
            });
        }
    }
    weatherDescElement.textContent = desc;

    // Updated precip_prob
    // updated precip_prob
    // Unified Precipitation Display
    const prob = Math.round(forecast.precip_prob ?? 0);
    let pType = determinePrecipitationType(forecast);

    // Type Inference: If probability is significant but type is missing, infer it
    if (prob > 15 && (pType === 'None' || pType === 'Clear' || !pType)) {
        pType = (forecast.tmax < 2) ? 'Snow' : 'Rain';
    }

    // Translate Type
    const precipMap = weatherMaps[currentLang];
    if (precipMap && precipMap[pType]) {
        pType = precipMap[pType];
    }

    const summaryEl = document.getElementById('precipSummary');
    if (summaryEl) {
        // Display based on probability thresholds - CONCISE format
        if (prob <= 30) {
            // 0-30%: No precipitation
            const clearMsg = currentLang === 'tr' ? '☀️ Yağış beklenmiyor' : '☀️ No precipitation';
            summaryEl.textContent = clearMsg;
        } else if (prob <= 50) {
            // 30-50%: Low chance - show percentage
            const typeStr = (pType && pType !== 'None' && pType !== 'Clear' && pType !== 'Açık') ? ` ${pType}` : '';
            summaryEl.textContent = `🌤️ ${prob}%${typeStr}`;
        } else {
            // 50%+: High chance - SIMPLE format: "🌧️ 99% Rain"
            const typeStr = (pType && pType !== 'None' && pType !== 'Clear' && pType !== 'Açık') ? ` ${pType}` : '';
            summaryEl.textContent = `🌧️ ${prob}%${typeStr}`;
        }
    }

    // NEW: Update Background based on weather
    updateBackground(forecast);
}

function updateBackground(forecast) {
    const desc = (forecast.weather_desc || '').toLowerCase();
    const pType = (forecast.precip_type || '').toLowerCase();
    const mm = Number(forecast.precip_mm || 0);
    const tmax = Number(forecast.tmax || 0);

    console.log(`[BG] desc="${desc}", pType="${pType}", mm=${mm}, tmax=${tmax}`);

    let gradient = 'var(--bg-gradient-default)';

    // Priority order: Storm > Snow > Rain > Cloudy > Sunny > Default
    // Sunny also triggers on warm days (25°C+) without bad weather
    // Snow also triggers on very cold days (<= -3°C)
    const isWarm = tmax >= 25;
    const isCold = tmax <= -3;

    if (desc.includes('thunder') || desc.includes('storm')) {
        gradient = 'var(--bg-gradient-storm)';
    } else if (pType.includes('snow') || desc.includes('snow') || desc.includes('ice') || isCold) {
        gradient = 'var(--bg-gradient-snow)';
    } else if (pType.includes('rain') || desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower')) {
        gradient = 'var(--bg-gradient-rain)';
    } else if (desc.includes('cloud') || desc.includes('overcast') || desc.includes('fog') || desc.includes('mist')) {
        gradient = 'var(--bg-gradient-cloudy)';
    } else if (desc.includes('sun') || desc.includes('clear') || desc.includes('sunny') || isWarm) {
        gradient = 'var(--bg-gradient-sunny)';
    }

    document.body.style.backgroundImage = gradient;
}

// Toggles
function toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    const themeToggle = document.querySelector('.theme-toggle');
    if (themeToggle) themeToggle.textContent = isLight ? '🌙 Dark Mode' : '☀ Light Mode';

    // Re-trigger background update in case theme colors change

}

// Language & Translation System
const i18n = {
    en: {
        appTitle: "Weather Forecast",
        enterCity: "Enter city name...",
        getWeather: "Get Weather",
        welcomeTitle: "Welcome to NovaCast",
        welcomeText: "Enter a city name above to explore the forecast.",
        precipChance: "Precipitation",
        // precipType removed from UI
        favCities: "Favorite Cities",
        addToFav: "Add Current City to Favorites",
        planRecs: "📋 Plan Recommendations",
        warnings: {
            heat: "Extreme Heat Warning. Avoid prolonged exposure. 🔥",
            warm: "High temperatures expected. ☀️",
            cold: "Freezing temperatures. Frost likely. ❄️",
            snow: "Snow or Ice conditions expected. ❄️",
            rainHigh: "High probability of rain. ☔",
            rainChance: "Chance of precipitation. 🌧️",
            perfect: "Excellent weather conditions. 🌤️"
        }
    },
    tr: {
        appTitle: "Hava Durumu",
        enterCity: "Şehir ismi giriniz...",
        getWeather: "Hava Durumu",
        welcomeTitle: "NovaCast'e Hoşgeldiniz",
        welcomeText: "Tahmini görmek için yukarıya bir şehir ismi girin.",
        precipChance: "Yağış Durumu",
        // precipType removed from UI
        favCities: "Favori Şehirler",
        addToFav: "Şehri Favorilere Ekle",
        planRecs: "📋 Plan Tavsiyeleri",
        warnings: {
            heat: "Aşırı Sıcak Uyarısı. Uzun süre dışarıda kalmayınız. 🔥",
            warm: "Yüksek sıcaklık bekleniyor. ☀️",
            cold: "Donma tehlikesi. Buzlanma olabilir. ❄️",
            snow: "Kar veya Buzlanma bekleniyor. ❄️",
            rainHigh: "Yüksek yağış ihtimali. ☔",
            rainChance: "Yağış ihtimali var. 🌧️",
            perfect: "Dışarı aktiviteleri için harika hava! 🌤️"
        }
    }
};

const weatherMaps = {
    en: {
        'Rain': 'Rain', 'Snow': 'Snow', 'Mixed': 'Mixed', 'None': 'Clear', 'Clear': 'Clear',
        'Night': 'Night', 'Sun': 'Sun', 'Sleet': 'Sleet', 'Ice': 'Ice',
        'Showers': 'Showers', 'Light': 'Light', 'Heavy': 'Heavy', 'Thunderstorm': 'Thunderstorm',
        'Cloudy': 'Cloudy', 'Overcast': 'Overcast', 'Partly': 'Partly', 'Fog': 'Fog', 'Mist': 'Mist', 'Drizzle': 'Drizzle'
    },
    tr: {
        'Rain': 'Yağmur', 'Snow': 'Kar', 'Mixed': 'Karla Karışık', 'None': 'Açık', 'Clear': 'Açık',
        'Night': 'Gece', 'Sun': 'Güneş', 'Sleet': 'Karla Karışık', 'Ice': 'Buzlanma',
        'Showers': 'Sağanak', 'Light': 'Hafif', 'Heavy': 'Yoğun', 'Thunderstorm': 'Gök Gürültülü',
        'Cloudy': 'Bulutlu', 'Overcast': 'Kapalı', 'Partly': 'Parçalı', 'Fog': 'Sis', 'Mist': 'Pus', 'Drizzle': 'Çiseleyen'
    }
};

let currentLang = 'en'; // Default English

function toggleLanguage() {
    currentLang = currentLang === 'en' ? 'tr' : 'en';
    const btn = document.querySelector('.lang-toggle');
    // Simplified button text as requested
    if (btn) btn.textContent = currentLang === 'en' ? 'TR' : 'EN';

    applyLanguage();
}

function applyLanguage() {
    const t = i18n[currentLang];

    // Update simple text elements
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) el.textContent = t[key];
    });

    // Update placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
    });

    // Re-render current data to apply deep translations (Date, Desc, Warnings)
    if (currentForecastData && currentForecastData.daily && currentForecastData.cityName) {
        // Use the input date value to find the currently displayed day
        const dateInputVal = document.getElementById('dateInput').value;
        const target = currentForecastData.daily.find(f => f.date === dateInputVal) || currentForecastData.daily[0];

        if (target) {
            updateUI(currentForecastData.cityName, target.date, target);
        }
    }
}

// Toast notifications
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

window.showToast = showToast;

// Favorites
function loadFavorites() {
    const favorites = JSON.parse(localStorage.getItem('novaPulseFavorites')) || [];
    const container = document.getElementById('favoriteCities');
    if (!container) return;

    container.innerHTML = '';

    if (favorites.length === 0) {
        const noFavMsg = currentLang === 'tr' ? 'Henüz favori yok' : 'No favorites yet';
        container.innerHTML = `<p class="no-favorites">${noFavMsg}</p>`;
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
    let cityToAdd = currentCity;

    // If no active search, check the input field
    if (!cityToAdd) {
        const inputVal = document.getElementById('cityInput').value.trim();
        if (inputVal) {
            cityToAdd = inputVal;
        } else {
            showToast(currentLang === 'tr' ? 'Lütfen önce bir şehir girin.' : 'Please enter a city name first.', 'error');
            return;
        }
    }

    let favorites = JSON.parse(localStorage.getItem('novaPulseFavorites')) || [];
    // Title case formatting
    cityToAdd = cityToAdd.charAt(0).toUpperCase() + cityToAdd.slice(1);

    if (!favorites.includes(cityToAdd)) {
        favorites.push(cityToAdd);
        localStorage.setItem('novaPulseFavorites', JSON.stringify(favorites));
        loadFavorites();
        showToast(currentLang === 'tr' ? `${cityToAdd} favorilere eklendi` : `${cityToAdd} added to favorites`, 'success');
    } else {
        showToast(currentLang === 'tr' ? 'Bu şehir zaten favorilerde' : 'City already in favorites', 'info');
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

// Planner warnings
function updatePlannerWarnings(forecast) {
    const container = document.getElementById('warningsContainer');
    if (!container) return;

    container.innerHTML = '';
    const warnings = [];
    const currentPrecipType = determinePrecipitationType(forecast);

    const t = i18n[currentLang].warnings;

    // Temperature Warnings
    const tmax = Number(forecast.tmax);
    if (tmax >= 35) {
        warnings.push({ text: t.heat, level: 'danger' });
    } else if (tmax >= 30) {
        warnings.push({ text: t.warm, level: 'warning' });
    } else if (tmax <= 0) {
        warnings.push({ text: t.cold, level: 'danger' });
    }

    // Precip Warnings
    const p = Number(forecast.precip_prob ?? 0);
    const type = currentPrecipType.toLowerCase();

    if (type.includes('snow') || type.includes('ice') || type.includes('mixed')) {
        warnings.push({ text: t.snow, level: 'danger' });
    } else if (p >= 70) {
        warnings.push({ text: t.rainHigh, level: 'danger' });
    } else if (p >= 40) {
        warnings.push({ text: t.rainChance, level: 'warning' });
    }

    // Good Weather Bonus
    if (p < 20 && tmax > 18 && tmax < 28) {
        warnings.push({ text: t.perfect, level: 'success' });
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

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    applyInitialTheme();
    initializeDateInputs();
    loadFavorites();

    // Initial Empty State Check
    const emptyState = document.getElementById('emptyState');
    const weatherData = document.getElementById('weatherData');
    if (emptyState && weatherData) {
        emptyState.style.display = 'block';
        weatherData.style.display = 'none';
    }

    showStartupPopup();
});

// Startup popup
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

// Global window assignments
window.searchWeather = searchWeather;
window.refreshForecast = refreshForecast;
window.toggleTheme = toggleTheme;
window.toggleLanguage = toggleLanguage;
window.addToFavorites = addToFavorites;
window.selectFavorite = selectFavorite;
window.removeFavorite = removeFavorite;
window.closeStartupPopup = closeStartupPopup;
