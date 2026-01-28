const API_BASE_URL = 'https://your-backend/api/predict';
const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_FORECAST_DAYS = 540;
const MAX_CACHED_CITIES = 10;
let currentForecastData = null;
let currentCity = '';
let activeRequestId = 0;
const pendingRequests = new Map();
const cityCache = new Map();

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
        dateInput.addEventListener('click', function () {
            try {
                this.showPicker();
            } catch (e) {
                console.log('showPicker not supported');
            }
        });
    }
}
function applyInitialTheme() {
    const savedTheme = localStorage.getItem('theme');
    const isDark = savedTheme !== 'light';
    document.body.classList.toggle('light-mode', !isDark);

    const themeToggle = document.querySelector('.theme-toggle');
    if (themeToggle) themeToggle.textContent = isDark ? '☀ Light Mode' : '🌙 Dark Mode';

    const savedLang = localStorage.getItem('novacastLang');
    if (savedLang) currentLang = savedLang;
}
async function getCoordinates(city) {
    const geoUrl = `${GEOCODING_API_URL}?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;
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
            let match = data.results.find(r => normalize(r.name) === searchNorm);
            if (!match) {
                const startsWithMatches = data.results.filter(r =>
                    normalize(r.name).startsWith(searchNorm)
                );
                if (startsWithMatches.length > 0) {
                    startsWithMatches.sort((a, b) => a.name.length - b.name.length);
                    match = startsWithMatches[0];
                }
            }
            if (!match) {
                const includesMatches = data.results.filter(r =>
                    normalize(r.name).includes(searchNorm)
                );
                if (includesMatches.length > 0) {
                    includesMatches.sort((a, b) => a.name.length - b.name.length);
                    match = includesMatches[0];
                }
            }
            if (!match) {
                console.warn(`[GEO] No match for "${city}", using first result: ${data.results[0].name}`);
                match = data.results[0];
            }

            console.log(`[GEO] Resolved "${city}" → ${match.name} (${match.country || 'Unknown'})`);
            const capitalize = (str) => {
                const first = str.charAt(0);
                const upper = first === 'i' ? 'İ' : first.toUpperCase();
                return upper + str.slice(1).toLowerCase();
            };
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

function isCacheValid() {
    if (!currentForecastData || !currentForecastData.expiresAt) return false;
    return Date.now() < currentForecastData.expiresAt;
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

    if (!forceRefresh) {
        const cacheKey = city.toLowerCase();
        const cached = cityCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            const cachedForecast = cached.daily.find(f => f.date === selectedISO);
            if (cachedForecast) {
                console.log(`[MULTI-CACHE] HIT for ${city} (${Math.round((cached.expiresAt - Date.now()) / 60000)} mins left)`);
                currentForecastData = cached;
                currentCity = cached.cityName;
                updateUI(cached.cityName, selectedISO, cachedForecast);
                return;
            }
        }
    }

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
        const BUFFER_DAYS = 45;
        let horizon = leadDays + BUFFER_DAYS;

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

        const forecastList = rawData.daily || [];
        const ttl = rawData.meta && rawData.meta.ttl_seconds ? rawData.meta.ttl_seconds : 3600;

        currentForecastData = {
            daily: forecastList,
            expiresAt: Date.now() + (ttl * 1000),
            cityName: location.resolvedName || city
        };
        currentCity = location.resolvedName || city;

        const cacheKey = city.toLowerCase();
        cityCache.set(cacheKey, currentForecastData);
        if (cityCache.size > MAX_CACHED_CITIES) {
            const oldestKey = cityCache.keys().next().value;
            cityCache.delete(oldestKey);
            console.log(`[CACHE] Evicted ${oldestKey} (LRU)`);
        }

        const targetForecast = forecastList.find(f => {
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

function updateUI(city, isoDate, forecast) {
    const emptyState = document.getElementById('emptyState');
    const weatherData = document.getElementById('weatherData');

    if (emptyState) emptyState.style.display = 'none';
    if (weatherData) weatherData.style.display = 'block';

    document.getElementById('cityName').textContent = city;

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

    if (forecast.tmin !== undefined && forecast.tmin !== null) {
        const nightLabel = currentLang === 'tr' ? 'Gece' : 'Night';
        document.getElementById('tempLow').textContent = `${nightLabel}: ${Math.round(forecast.tmin)}°C`;
    } else {
        document.getElementById('tempLow').textContent = '';
    }

    const weatherDescElement = document.getElementById('weatherDesc');
    const oldBadge = weatherDescElement.querySelector('.data-source-badge');
    if (oldBadge) oldBadge.remove();

    let desc = customDesc || forecast.weather_desc || (currentLang === 'tr' ? 'Parçalı Bulutlu' : 'Partly Cloudy');

    const map = weatherMaps[currentLang];
    if (map) {
        if (map[desc]) {
            desc = map[desc];
        } else {
            const keys = Object.keys(map).sort((a, b) => b.length - a.length);
            keys.forEach(key => {
                if (desc.includes(key)) {
                    desc = desc.split(key).join(map[key]);
                }
            });
        }
    }
    weatherDescElement.textContent = desc;

    const prob = Math.round(forecast.precip_prob ?? 0);
    let pType = determinePrecipitationType(forecast);

    if (prob > 15 && (pType === 'None' || pType === 'Clear' || !pType)) {
        pType = (forecast.tmax < 2) ? 'Snow' : 'Rain';
    }

    const precipMap = weatherMaps[currentLang];
    if (precipMap && precipMap[pType]) {
        pType = precipMap[pType];
    }

    const summaryEl = document.getElementById('precipSummary');
    if (summaryEl) {

        if (prob <= 30) {

            const clearMsg = currentLang === 'tr' ? '☀️ Yağış beklenmiyor' : '☀️ No precipitation';
            summaryEl.textContent = clearMsg;
        } else if (prob <= 50) {

            const typeStr = (pType && pType !== 'None' && pType !== 'Clear' && pType !== 'Açık') ? ` ${pType}` : '';
            summaryEl.textContent = `🌤️ ${prob}%${typeStr}`;
        } else {

            const typeStr = (pType && pType !== 'None' && pType !== 'Clear' && pType !== 'Açık') ? ` ${pType}` : '';
            summaryEl.textContent = `🌧️ ${prob}%${typeStr}`;
        }
    }

    updateBackground(forecast);
}

function updateBackground(forecast) {
    const desc = (forecast.weather_desc || '').toLowerCase();
    const pType = (forecast.precip_type || '').toLowerCase();
    const mm = Number(forecast.precip_mm || 0);
    const tmax = Number(forecast.tmax || 0);

    console.log(`[BG] desc="${desc}", pType="${pType}", mm=${mm}, tmax=${tmax}`);

    let gradient = 'var(--bg-gradient-default)';

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

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    const themeToggle = document.querySelector('.theme-toggle');
    if (themeToggle) themeToggle.textContent = isLight ? '🌙 Dark Mode' : '☀ Light Mode';

}

const i18n = {
    en: {
        appTitle: "Weather Forecast",
        enterCity: "Enter city name...",
        getWeather: "Get Weather",
        welcomeTitle: "Welcome to Novacast",
        welcomeText: "Enter a city name above to explore the forecast.",
        precipChance: "Precipitation",
        favCities: "Favorite Cities",
        addToFav: "Add Current City to Favorites",
        planRecs: "📋 Plan Recommendations",
        useLocation: "Use my location",
        selectDate: "Select Date",
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
        welcomeTitle: "Novacast'e Hoşgeldiniz",
        welcomeText: "Tahmini görmek için yukarıya bir şehir ismi girin.",
        precipChance: "Yağış Durumu",
        favCities: "Favori Şehirler",
        addToFav: "Şehri Favorilere Ekle",
        planRecs: "📋 Plan Tavsiyeleri",
        useLocation: "Konumumu Kullan",
        selectDate: "Tarih Seç",
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
        'Rain Showers': 'Sağanak Yağış',
        'Snow Showers': 'Kar Yağışı',
        'Light Rain': 'Hafif Yağmur',
        'Heavy Rain': 'Şiddetli Yağmur',
        'Light Snow': 'Hafif Kar',
        'Heavy Snow': 'Yoğun Kar',
        'Mainly Clear': 'Çoğunlukla Açık',
        'Partly Cloudy': 'Parçalı Bulutlu',

        'Rain': 'Yağmurlu', 'Snow': 'Karlı', 'Mixed': 'Karla Karışık', 'None': 'Açık', 'Clear': 'Açık',
        'Night': 'Gece', 'Sun': 'Güneşli', 'Sleet': 'Karla Karışık', 'Ice': 'Buzlanma',
        'Showers': 'Sağanak', 'Light': 'Hafif', 'Heavy': 'Yoğun', 'Thunderstorm': 'Gök Gürültülü',
        'Cloudy': 'Bulutlu', 'Overcast': 'Kapalı', 'Partly': 'Parçalı', 'Fog': 'Sisli', 'Mist': 'Puslu', 'Drizzle': 'Çiseleyen'
    }
};

let currentLang = 'en';

function toggleLanguage() {
    currentLang = currentLang === 'en' ? 'tr' : 'en';
    localStorage.setItem('novacastLang', currentLang);
    const btn = document.querySelector('.lang-toggle');
    if (btn) btn.textContent = currentLang === 'en' ? 'TR' : 'EN';

    applyLanguage();
}

function applyLanguage() {
    const t = i18n[currentLang];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) el.textContent = t[key];
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (t[key]) el.title = t[key];
    });

    if (currentForecastData && currentForecastData.daily && currentForecastData.cityName) {

        const dateInputVal = document.getElementById('dateInput').value;
        const target = currentForecastData.daily.find(f => f.date === dateInputVal) || currentForecastData.daily[0];

        if (target) {
            updateUI(currentForecastData.cityName, target.date, target);
        }
    }
}

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

    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease-out forwards';
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 4000);
}

window.showToast = showToast;

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

        const nameSpan = document.createElement('span');
        nameSpan.textContent = city;
        nameSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            selectFavorite(city);
        });

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeFavorite(city);
        });

        cityDiv.appendChild(nameSpan);
        cityDiv.appendChild(removeBtn);
        cityDiv.addEventListener('click', (e) => {
            if (e.target !== removeBtn) {
                selectFavorite(city);
            }
        });

        container.appendChild(cityDiv);
    });
}

function addToFavorites() {
    let cityToAdd = currentCity;

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

function updatePlannerWarnings(forecast) {
    const container = document.getElementById('warningsContainer');
    if (!container) return;

    container.innerHTML = '';
    const warnings = [];
    const currentPrecipType = determinePrecipitationType(forecast);

    const t = i18n[currentLang].warnings;

    const tmax = Number(forecast.tmax);
    if (tmax >= 35) {
        warnings.push({ text: t.heat, level: 'danger' });
    } else if (tmax >= 30) {
        warnings.push({ text: t.warm, level: 'warning' });
    } else if (tmax <= 0) {
        warnings.push({ text: t.cold, level: 'danger' });
    }

    const p = Number(forecast.precip_prob ?? 0);
    const type = currentPrecipType.toLowerCase();

    if (type.includes('snow') || type.includes('ice') || type.includes('mixed')) {
        warnings.push({ text: t.snow, level: 'danger' });
    } else if (p >= 70) {
        warnings.push({ text: t.rainHigh, level: 'danger' });
    } else if (p >= 40) {
        warnings.push({ text: t.rainChance, level: 'warning' });
    }

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

document.addEventListener('DOMContentLoaded', () => {
    applyInitialTheme();

    const langBtn = document.querySelector('.lang-toggle');
    if (langBtn) langBtn.textContent = currentLang === 'en' ? 'TR' : 'EN';
    applyLanguage();

    initializeDateInputs();
    loadFavorites();

    const emptyState = document.getElementById('emptyState');
    const weatherData = document.getElementById('weatherData');
    if (emptyState && weatherData) {
        emptyState.style.display = 'block';
        weatherData.style.display = 'none';
    }

    showStartupPopup();
});

function showStartupPopup() {
    if (localStorage.getItem('startupPopupSeen')) return;

    const titleText = currentLang === 'tr' ? 'NovaCast\'a Hoşgeldiniz!' : 'Welcome to NovaCast!';
    const bodyText = currentLang === 'tr'
        ? 'Sunucumuz uyandığı için ilk tahmin <strong>1 dakika</strong> kadar sürebilir (Soğuk Başlangıç).<br><br>Lütfen sabırlı olun, sonraki istekler çok daha hızlı olacak! ⚡'
        : 'Since our AI models run on a free tier server, the first prediction might take up to <strong>1 minute</strong> to wake up the system (Cold Start).<br><br>Please be patient, subsequent requests will be much faster! ⚡';
    const buttonText = currentLang === 'tr' ? 'Anladım, teşekkürler!' : 'Got it, thanks!';

    const popupOverlay = document.createElement('div');
    popupOverlay.className = 'popup-overlay';
    popupOverlay.innerHTML = `
        <div class="popup-content">
        <div class="popup-icon">🚀</div>
        <div class="popup-title">${titleText}</div>
        <div class="popup-text">${bodyText}</div>
        <button class="popup-close-btn" onclick="closeStartupPopup(this)">${buttonText}</button>
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

window.searchWeather = searchWeather;
window.refreshForecast = refreshForecast;
window.toggleTheme = toggleTheme;
window.toggleLanguage = toggleLanguage;
window.addToFavorites = addToFavorites;
window.selectFavorite = selectFavorite;
window.removeFavorite = removeFavorite;
window.closeStartupPopup = closeStartupPopup;
window.useMyLocation = useMyLocation;
window.openDatePicker = openDatePicker;

function openDatePicker() {
    const input = document.getElementById('dateInput');
    if (input) {
        if ('showPicker' in HTMLInputElement.prototype) {
            try {
                input.showPicker();
            } catch (err) {
                console.warn('showPicker failed, trying focus/click', err);
                input.focus();
                input.click();
            }
        } else {
            input.focus();
            input.click();
        }
    }
}

async function useMyLocation() {
    const btn = document.querySelector('.location-btn');

    if (!navigator.geolocation) {
        showToast(currentLang === 'tr' ? 'Tarayıcınız konum desteklemiyor.' : 'Your browser does not support geolocation.', 'error');
        return;
    }

    btn?.classList.add('loading');

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            try {
                const { latitude, longitude } = pos.coords;
                const response = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&accept-language=${currentLang}`
                );
                const data = await response.json();

                const cityName = data.address?.city || data.address?.town || data.address?.municipality || data.address?.village || data.address?.county ||
                    (currentLang === 'tr' ? 'Konumunuz' : 'Your Location');

                document.getElementById('cityInput').value = cityName;
                btn?.classList.remove('loading');

                showToast(currentLang === 'tr' ? `📍 Konum algılandı: ${cityName}` : `📍 Location detected: ${cityName}`, 'success');
                searchWeather();
            } catch (err) {
                btn?.classList.remove('loading');
                showToast(currentLang === 'tr' ? 'Konum bilgisi alınamadı.' : 'Could not get location info.', 'error');
            }
        },
        (err) => {
            btn?.classList.remove('loading');
            const msgs = {
                1: currentLang === 'tr' ? 'Konum izni reddedildi.' : 'Location permission denied.',
                2: currentLang === 'tr' ? 'Konum alınamadı.' : 'Location unavailable.',
                3: currentLang === 'tr' ? 'Konum isteği zaman aşımına uğradı.' : 'Location request timed out.'
            };
            showToast(msgs[err.code] || err.message, 'error');
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
}

