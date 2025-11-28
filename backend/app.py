from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, date
from typing import Optional
import traceback
import sys
import os

# Ensure the current directory is in sys.path so we can import nova_logic
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from nova_logic import forecast_core, VERSION
except ImportError:
    # ERROR: 'nova_logic.py' not found.
    print("ERROR: 'nova_logic.py' not found.")
    VERSION = "Module Could Not Be Loaded"
    forecast_core = None

# Initialize FastAPI application (NovaCast Weather Forecast API)
app = FastAPI(title="NovaCast Weather Forecast API")

# Add CORS Middleware to allow requests from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic model for the request body
class WeatherRequest(BaseModel):
    lat: float
    lon: float
    target_date: str
    horizon_days: Optional[int] = 150

@app.get("/")
def home():
    # Return a simple status message since frontend is hosted separately
    return {"status": "ok", "message": "NovaCast API is running", "version": VERSION}

@app.post("/api/predict")
def predict_weather(req: WeatherRequest):
    if forecast_core is None:
        # Raise 503 if the core logic could not be loaded
        raise HTTPException(
            status_code=503,
            detail="Forecast service is not ready (nova_logic.py could not be loaded)."
        )

    try:
        # Convert target_date string to date object (YYYYMMDD)
        target_date_obj = datetime.strptime(req.target_date, "%Y%m%d").date()
        today = date.today()
        # Calculate the number of days between today and the target date
        horizon_days = (target_date_obj - today).days

        if horizon_days < 0:
            raise HTTPException(status_code=400, detail="Target date cannot be in the past.")

        # Determine the required forecast horizon
        required_horizon = max(req.horizon_days, horizon_days + 1)
        required_horizon = min(required_horizon, 540) # Limit increased

        # Call the core forecasting function
        full_output, daily_forecasts = forecast_core(
            lat=req.lat,
            lon=req.lon,
            horizon_days=required_horizon,
            debug=True
        )

        if not daily_forecasts or len(daily_forecasts) == 0:
            # ERROR: forecast_core returned an empty list.
            print("ERROR: forecast_core returned an empty list.")
            raise HTTPException(
                status_code=404,
                detail="No daily data received from the forecast engine."
            )

        # Returning N days of data
        print(f"✓ Returning {len(daily_forecasts)} days of data")
        return {"daily": daily_forecasts}

    except ValueError:
        # Handle incorrect date format
        raise HTTPException(
            status_code=400,
            detail="Incorrect target_date format. Expected format: YYYYMMDD"
        )
    except HTTPException as http_e:
        # Re-raise explicit HTTPExceptions
        raise http_e
    except Exception as e:
        # Catch and handle all other unexpected server errors
        print("="*50)
        print("❌ UNEXPECTED SERVER ERROR:")
        print(f"Error: {str(e)}")
        print(traceback.format_exc())
        print("="*50)
        raise HTTPException(
            status_code=500,
            detail=f"Server error during forecast: {e.__class__.__name__}"
        )
