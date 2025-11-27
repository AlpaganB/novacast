from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, date
from typing import Optional
import traceback
import os

try:
    from nova_logic import forecast_core, VERSION
except ImportError:
    print("HATA: 'nova_logic.py' bulunamadı.")
    VERSION = "Modül Yüklenemedi"
    forecast_core = None

app = FastAPI(title="NovaCast Hava Durumu Tahmin API'si")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Statik dosyaları (frontend) sunmak için
app.mount("/static", StaticFiles(directory="frontend"), name="static")

class WeatherRequest(BaseModel):
    lat: float
    lon: float
    target_date: str
    horizon_days: Optional[int] = 360

@app.get("/")
def home():
    # Frontend ana sayfasını sun
    return FileResponse('frontend/index.html')

@app.post("/api/predict")
def predict_weather(req: WeatherRequest):
    if forecast_core is None:
        raise HTTPException(
            status_code=503,
            detail="Tahmin servisi hazır değil (nova_logic.py yüklenemedi)."
        )

    try:
        target_date_obj = datetime.strptime(req.target_date, "%Y%m%d").date()
        today = date.today()
        horizon_days = (target_date_obj - today).days

        if horizon_days < 0:
            raise HTTPException(status_code=400, detail="Hedef tarih geçmişte olamaz.")

        required_horizon = max(req.horizon_days, horizon_days + 1)
        required_horizon = min(required_horizon, 540) # Limit artırıldı

        full_output, daily_forecasts = forecast_core(
            lat=req.lat,
            lon=req.lon,
            horizon_days=required_horizon,
            debug=True
        )

        if not daily_forecasts or len(daily_forecasts) == 0:
            print("HATA: forecast_core boş liste döndürdü.")
            raise HTTPException(
                status_code=404,
                detail="Tahmin motorundan günlük veri alınamadı."
            )

        print(f"✓ {len(daily_forecasts)} günlük veri döndürülüyor")
        return {"gunluk": daily_forecasts}

    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="target_date formatı yanlış. Beklenen format: YYYYMMDD"
        )
    except HTTPException as http_e:
        raise http_e
    except Exception as e:
        print("="*50)
        print("❌ BEKLENMEDIK SUNUCU HATASI:")
        print(f"Hata: {str(e)}")
        print(traceback.format_exc())
        print("="*50)
        raise HTTPException(
            status_code=500,
            detail=f"Tahmin sırasında sunucu hatası: {e.__class__.__name__}"
        )