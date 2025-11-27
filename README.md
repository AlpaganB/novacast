# NovaCast Weather Forecast

A modern weather forecasting application built for the NASA Space Apps Challenge 2025. NovaCast uses ensemble prediction methods with NASA POWER and ERA5 data to deliver accurate long-range weather forecasts up to 1.5 years ahead.

## Features

- **Long-Range Forecasts** - Extended predictions up to 540 days (1.5 years) into the future
- **Ensemble Data Sources** - Combines NASA POWER API and Open-Meteo ERA5 for improved accuracy
- **Smart Blending** - Uses 50/50 ensemble of POWER + ERA5 for robust climatology
- **Intelligent Caching** - Graduated cache strategy (1h/3h/6h) based on forecast range
- **Dark/Light Themes** - User-friendly interface with seamless theme switching
- **Planner Mode** - Weather-based activity recommendations with smooth animations
- **Favorite Cities** - Save and quickly access your most-checked locations
- **PWA Support** - Install as a mobile or desktop app with offline capability
- **Responsive Design** - Works flawlessly on all devices

## Tech Stack

### Backend
- **FastAPI** (Python) - High-performance API framework
- **NASA POWER API** - Satellite-based climate data
- **Open-Meteo ERA5** - Historical reanalysis data (2015-present)
- **Open-Meteo Forecast** - 0-16 day NWP predictions
- **Open-Meteo Geocoding** - City name to coordinates
- **Pandas & NumPy** - Data processing and ensemble calculations

### Frontend
- **Vanilla JavaScript** - No frameworks, pure performance
- **CSS3** - Smooth animations and glassmorphism effects
- **Service Worker** - PWA support with offline capability

### Backend Setup

```bash
git clone [https://github.com/AlpaganB/novacast.git](https://github.com/yourusername/novacast.git)
cd novacast
```
``` terminal
pip install -r requirements.txt
```

#### Deployment
Backend: Deploy to Render, Railway, or any Python hosting service.
Frontend: Deploy to any static hosting (cPanel, Netlify, Vercel, etc.)

#### Configuration
Before deploying the frontend, update the API URL in script.min.js:
```script.js
const API_BASE_URL = '[https://your-backend-url.com/api/predict'](https://your-backend-url.com/api/predict');
```

## Cache Strategy

NovaCast implements intelligent caching to balance freshness and performance:

- **Near-term forecasts (≤3 days):** 1-hour cache
- **Mid-range forecasts (4-7 days):** 3-hour cache
- **Long-range forecasts (8+ days):** 6-hour cache

This reduces API calls while ensuring fresh data when it matters most.

## Browser Support

Works on all modern browsers with ES6+ support:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Most mobile browsers

**Note:** Internet Explorer is not supported.

## Contributing

We welcome contributions! Feel free to:
- Report bugs via Issues
- Suggest new features
- Submit pull requests

## License

This project was developed for the NASA Space Apps Challenge 2025 by NovaPulse.

## Credits

**Team:** NovaPulse  

**Data Sources:**
- NASA POWER API
- Open-Meteo ERA5
- Open-Meteo Forecast API
- Open-Meteo Geocoding

**Challenge:** NASA Space Apps Challenge 2025

## Acknowledgments

Special thanks to NASA for providing the POWER API and making long-range climate predictions accessible. Thanks to Open-Meteo for their comprehensive weather data services.

Built with passion by NovaPulse.


