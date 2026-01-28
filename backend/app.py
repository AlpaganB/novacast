from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, date
from typing import Optional
import traceback
import sys
import os

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from nova_logic import forecast_core, VERSION
except ImportError:
    print("ERROR: 'nova_logic.py' not found.")
    VERSION = "Module Could Not Be Loaded"
    forecast_core = None

app = FastAPI(title="NovaCast Weather Forecast API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class WeatherRequest(BaseModel):
    lat: float
    lon: float
    target_date: str
    horizon_days: Optional[int] = 150

@app.get("/")
async def home():
    return {"status": "ok", "message": "NovaCast API is running", "version": VERSION}

@app.post("/api/predict")
async def predict_weather(req: WeatherRequest):
    if forecast_core is None:
        raise HTTPException(
            status_code=503,
            detail="Forecast service is not ready (nova_logic.py could not be loaded)."
        )

    try:
        target_date_obj = datetime.strptime(req.target_date, "%Y%m%d").date()
        today = date.today()
        horizon_days = (target_date_obj - today).days

        if horizon_days < 0:
            raise HTTPException(status_code=400, detail="Target date cannot be in the past.")

        required_horizon = max(req.horizon_days, horizon_days + 1)
        required_horizon = min(required_horizon, 540)

        full_output, daily_forecasts = await forecast_core(
            lat=req.lat,
            lon=req.lon,
            horizon_days=required_horizon,
            debug=True
        )

        if not daily_forecasts or len(daily_forecasts) == 0:
            print("ERROR: forecast_core returned an empty list.")
            raise HTTPException(
                status_code=404,
                detail="No daily data received from the forecast engine."
            )

        print(f"✓ Returning {len(daily_forecasts)} days of data")
        return {"daily": daily_forecasts}

    except ValueError as ve:
        print("="*50)
        print(f"❌ ValueError caught: {str(ve)}")
        print(traceback.format_exc())
        print("="*50)
        raise HTTPException(
            status_code=400,
            detail=f"Data processing error: {str(ve)}"
        )
    except HTTPException as http_e:
        raise http_e
    except Exception as e:
        print("="*50)
        print("❌ UNEXPECTED SERVER ERROR:")
        print(f"Error: {str(e)}")
        print(traceback.format_exc())
        print("="*50)
        raise HTTPException(
            status_code=500,
            detail=f"Server error during forecast: {e.__class__.__name__}"
        )
