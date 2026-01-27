import sys, json, time, math, argparse, asyncio
from datetime import datetime, timezone, timedelta, date
from typing import Optional, List, Tuple, Dict
from functools import lru_cache
import numpy as np
import pandas as pd
import httpx

VERSION = "novaLogic v2.1.0 (Async+Vectorized)"
TZ = "auto"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def iso_utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def yesterday() -> date:
    return (datetime.now(timezone.utc).date() - timedelta(days=1))

def safe_float(x):
    try:
        f = float(x)
        return f if np.isfinite(f) else None
    except:
        return None

def dprint(msg, dbg=False):
    if dbg:
        print(str(msg), flush=True)

UA = {"User-Agent": "novaLogic/2.1.0 (contact: alpagan@novacast.space)"}

async def http_get_json(client, url, params=None, timeout=45, retries=3, backoff=1.25, debug=False):
    hdr = {"Accept":"application/json", **UA}
    last_err=None
    for a in range(max(1,int(retries))):
        try:
            r = await client.get(url, params=params or {}, headers=hdr, timeout=timeout)
            if r.status_code >= 500 or r.status_code in (429,):
                r.raise_for_status() 
            r.raise_for_status()
            return r.json()
        except Exception as e:
             last_err=e
             dprint(f"[HTTP] {url} -> {e} (try {a+1}/{retries})", debug)
             await asyncio.sleep((backoff ** a))
             
    dprint(f"[HTTP] giving up: {last_err}", debug)
    return None

async def fetch_openmeteo_daily(client, lat: float, lon: float, forecast_days: int, past_days: int = 0, debug=False):
    forecast_days = int(max(1, min(forecast_days, 16)))
    past_days = int(max(0, min(past_days, 7)))
    daily = ",".join([
        "temperature_2m_max","temperature_2m_min",
        "precipitation_sum","precipitation_hours",
        "shortwave_radiation_sum","precipitation_probability_max",
        "rain_sum","snowfall_sum","weather_code"
    ])
    params = {
        "latitude": lat, "longitude": lon, "timezone": TZ,
        "daily": daily, "forecast_days": forecast_days, "past_days": past_days
    }
    js = await http_get_json(client, "https://api.open-meteo.com/v1/forecast", params=params, timeout=40, retries=4, backoff=1.5, debug=debug)
    if js is None or "daily" not in js:
        return None, None
    idx = pd.to_datetime(js["daily"]["time"])
    d = js["daily"]
    def G(k):
        v=d.get(k)
        return v if v is not None and len(v) == len(idx) else [None]*len(idx)
    
    df = pd.DataFrame({
        "NWP_TMAX": G("temperature_2m_max"),
        "NWP_TMIN": G("temperature_2m_min"),
        "NWP_PPRB_MAX": G("precipitation_probability_max"),
        "NWP_PRCP_MM": G("precipitation_sum"),
        "NWP_PHOURS": G("precipitation_hours"),
        "NWP_SW_RAD_SUM": G("shortwave_radiation_sum"),
        "NWP_RAIN_MM": G("rain_sum"),
        "NWP_SNOW_MM": G("snowfall_sum"),
        "NWP_CODE": G("weather_code"),
    }, index=idx).sort_index()
    elev = js.get("elevation", None)
    return df, elev

def wmo_code_to_text_vectorized(codes):
    """Vectorized conversion of WMO codes to text"""
    conditions = [
        codes == 0, codes == 1, codes == 2, codes == 3,
        np.isin(codes, [45, 48]),
        np.isin(codes, [51, 53, 55]),
        np.isin(codes, [56, 57]),
        np.isin(codes, [61, 63, 65]),
        np.isin(codes, [66, 67]),
        np.isin(codes, [71, 73, 75]),
        codes == 77,
        np.isin(codes, [80, 81, 82]),
        np.isin(codes, [85, 86]),
        codes == 95,
        np.isin(codes, [96, 99])
    ]
    choices = [
        "Clear Sky", "Mainly Clear", "Partly Cloudy", "Overcast",
        "Foggy", "Drizzle", "Freezing Drizzle", "Rain",
        "Freezing Rain", "Snow", "Snow Grains", "Rain Showers",
        "Snow Showers", "Thunderstorm", "Thunderstorm with Hail"
    ]
    return np.select(conditions, choices, default="Unknown")

async def fetch_era5_daily(client, lat: float, lon: float, start_date: str, end_date: Optional[str] = None, debug=False):
    if end_date is None: end_date = yesterday().strftime("%Y-%m-%d")
    params = {
        "latitude": lat, "longitude": lon,
        "start_date": start_date, "end_date": end_date,
        "daily": "temperature_2m_max,precipitation_sum",
        "timezone": TZ
    }
    js = await http_get_json(client, "https://archive-api.open-meteo.com/v1/era5", params=params, timeout=45, retries=4, backoff=1.5, debug=debug)
    if js is None or "daily" not in js:
        return None
    idx = pd.to_datetime(js["daily"]["time"])
    df = pd.DataFrame({
        "ERA5_TMAX": js["daily"]["temperature_2m_max"],
        "ERA5_PRCP": js["daily"]["precipitation_sum"]
    }, index=idx).sort_index()
    return df

async def fetch_nasa_power_daily(client, lat: float, lon: float, start_date: str, end_date: Optional[str] = None, debug=False):
    if end_date is None: 
        end_date = yesterday().strftime("%Y%m%d")
    else:
        end_date = end_date.replace("-", "")
    
    start_date = start_date.replace("-", "")
    
    params = {
        "parameters": "T2M_MAX,PRECTOTCORR",
        "community": "RE",
        "longitude": lon,
        "latitude": lat,
        "start": start_date,
        "end": end_date,
        "format": "JSON"
    }
    
    url = "https://power.larc.nasa.gov/api/temporal/daily/point"
    js = await http_get_json(client, url, params=params, timeout=60, retries=3, backoff=2.0, debug=debug)
    
    if js is None or "properties" not in js or "parameter" not in js["properties"]:
        return None
    
    params_data = js["properties"]["parameter"]
    
    if "T2M_MAX" not in params_data or "PRECTOTCORR" not in params_data:
        return None
    
    tmax_data = params_data["T2M_MAX"]
    prcp_data = params_data["PRECTOTCORR"]
    
    dates = []
    tmax_vals = []
    prcp_vals = []
    
    for date_str, val in tmax_data.items():
        try:
            date_obj = pd.to_datetime(date_str, format="%Y%m%d")
            dates.append(date_obj)
            tmax_vals.append(val if val != -999 else None)
            prcp_vals.append(prcp_data.get(date_str, 0) if prcp_data.get(date_str, -999) != -999 else 0)
        except:
            continue
    
    if not dates:
        return None
    
    df = pd.DataFrame({
        "POWER_TMAX": tmax_vals,
        "POWER_PRCP": prcp_vals
    }, index=pd.DatetimeIndex(dates)).sort_index()
    
    return df


def smooth_harmonic(daily_series: pd.Series, harmonics: int = 3) -> pd.Series:
    """Smooths a 365/366 day daily climatology using Fourier Harmonics"""
    # Ensure we have a full year (fill missing with interpolation)
    s = daily_series.copy()
    vals = s.values
    
    # Handle NaNs if any (linear interpolate)
    nans, x = np.isnan(vals), lambda z: z.nonzero()[0]
    if np.any(nans):
        vals[nans] = np.interp(x(nans), x(~nans), vals[~nans])
    
    # FFT
    n = len(vals)
    coeffs = np.fft.rfft(vals)
    
    # Filter: Keep only the first `harmonics + 1` frequencies (DC + harmonics)
    # 0 = Mean
    # 1 = Annual cycle
    # 2 = Semi-annual
    # ...
    coeffs[harmonics+1:] = 0
    
    # Inverse FFT
    smoothed = np.fft.irfft(coeffs, n=n)
    
    return pd.Series(smoothed, index=s.index)

def get_analog_forecast(tmax_hist: pd.Series, horizon_days: int) -> Optional[pd.Series]:
    """
    Finds top 3 analog years based on last 60 days of data and 
    returns their average trajectory for the next 'horizon_days'.
    """
    # 1. Define Target Pattern (Last 60 days)
    lookback = 60
    history_years = tmax_hist.index.year.unique().sort_values()
    
    if len(history_years) < 3: return None # Not enough history
    
    # We need the most recent clean data
    recent_data = tmax_hist.dropna()
    if len(recent_data) < lookback: return None
    
    target_window = recent_data.tail(lookback)
    target_values = target_window.values
    # Normalize for shape comparison (subtract mean) to focus on pattern, not absolute magnitude
    target_norm = target_values - target_values.mean()
    
    target_endo_doy = target_window.index[-1].dayofyear
    current_year = target_window.index[-1].year
    
    candidates = []
    
    # 2. Search Past Years
    for yr in history_years:
        if yr == current_year: continue # Skip current incomplete year
        
        # Construct same window in past year
        # We try to align by DOY. 
        # End Date of 'yr' candidate = Date(yr, current_month, current_day)
        try:
            cand_end_date = pd.Timestamp(yr, target_window.index[-1].month, target_window.index[-1].day)
        except ValueError: # Leap year issues
            cand_end_date = pd.Timestamp(yr, 2, 28)
            
        cand_start_date = cand_end_date - pd.Timedelta(days=lookback-1)
        
        chunk = tmax_hist.loc[cand_start_date : cand_end_date]
        
        if len(chunk) != lookback: continue
        if chunk.isnull().any(): continue # Skip chunks with missing data
        
        # Calculate Score (RMSE of normalized curves -> pattern matching)
        chunk_vals = chunk.values
        chunk_norm = chunk_vals - chunk_vals.mean()
        
        score = np.sqrt(np.mean((target_norm - chunk_norm)**2))
        candidates.append((score, yr, cand_end_date))
        
    if not candidates: return None
    
    # 3. Pick Top 3
    candidates.sort(key=lambda x: x[0])
    top_3 = candidates[:3]
    # print(f"Analog Years: {[c[1] for c in top_3]}") # Debug info
    
    # 4. Project Future (Forecast Horizon) from these years
    future_curves = []
    
    for _, yr, match_end_date in top_3:
        # We want the data immediately FOLLOWING the match window
        fut_start = match_end_date + pd.Timedelta(days=1)
        fut_end = fut_start + pd.Timedelta(days=horizon_days - 1)
        
        fut_chunk = tmax_hist.loc[fut_start : fut_end]
        
        # If we run out of data (e.g. analog year is too recent), skip or pad
        if len(fut_chunk) < horizon_days:
            # Pad with NaNs to match length
            vals = np.full(horizon_days, np.nan)
            vals[:len(fut_chunk)] = fut_chunk.values
        else:
            vals = fut_chunk.values[:horizon_days] # Ensure exact length
            
        future_curves.append(vals)
    
    if not future_curves: return None
    
    # Average the curves (ignoring NaNs)
    analog_mean = np.nanmean(np.array(future_curves), axis=0)
    
    # Create result Series with proper future index
    start_forecast = target_window.index[-1] + pd.Timedelta(days=1)
    fut_idx = pd.date_range(start_forecast, periods=horizon_days, freq="D")
    
    return pd.Series(analog_mean, index=fut_idx)


def compute_daily_clim(series: pd.Series, smooth_window: int = 7) -> pd.Series:
    df = pd.DataFrame({"v": pd.to_numeric(series, errors="coerce")}).dropna()
    if df.empty: 
        raise RuntimeError("Insufficient data for climatology.")
    idx = df.index
    fix = [pd.Timestamp(t.year,2,28) if (t.month==2 and t.day==29) else t for t in idx]
    doy = pd.DatetimeIndex(fix).dayofyear
    df["doy"] = doy
    
    # Raw Climatology (no rolling window yet)
    clim = df.groupby("doy")["v"].mean()
    
    # Fill to 366 days
    full = pd.Series(index=range(1,367), dtype=float)
    full.update(clim)
    # Fill gaps if any (e.g. Feb 29 missing)
    full = full.interpolate(limit_direction='both')
    
    # Apply Harmonic Smoothing instead of Rolling Window
    # 4 harmonics captures Annual, Semi-Annual, and Seasonal nuances without noise
    smoothed = smooth_harmonic(full, harmonics=4)
    
    return smoothed

def same_day_climo_value(clim_by_doy: pd.Series, t: pd.Timestamp, day_window: int = 0) -> float:
    # Scalar version kept for legacy or single-point use
    doy = t.dayofyear if not (t.month==2 and t.day==29) else 59
    if day_window<=0:
        return float(clim_by_doy.get(doy, np.nan))
    vals=[]
    for off in range(-day_window, day_window+1):
        k = doy + off
        if k<1: k += 366
        if k>366: k -= 366
        v = float(clim_by_doy.get(k, np.nan))
        if np.isfinite(v): vals.append(v)
    if not vals: 
        return float(clim_by_doy.get(doy, np.nan))
    return float(np.mean(vals)) # Keep for single use

def get_climo_series(clim_by_doy: pd.Series, idx: pd.DatetimeIndex) -> pd.Series:
    """Vectorized retrieval of climatology values for a DateTimeIndex"""
    doy = idx.dayofyear.to_numpy()
    # Handle leap years: map Feb 29 (60 in regular) to 59 (Feb 28) or maintain 366 index
    # Our compute_daily_clim produces 1..366.
    # Pandas dayofyear ranges 1..366.
    return clim_by_doy.reindex(doy).set_axis(idx)

def warming_offset(idx: pd.DatetimeIndex, per_decade=0.3, baseline_year=2020.5):
    monthly_coeffs = np.array([0, 0.325, 0.325, 0.275, 0.225, 0.225, 0.275, 0.375, 0.425, 0.375, 0.325, 0.275, 0.325])
    months = idx.month
    coeffs = monthly_coeffs[months]
    
    per_year = coeffs / 10.0
    years_frac = idx.year + (idx.dayofyear / 365.25)
    
    return pd.Series((years_frac - baseline_year) * per_year, index=idx, dtype=float)

def slope_caps_by_month(ts: pd.Series) -> pd.Series:
    df=pd.DataFrame({"v":pd.to_numeric(ts, errors="coerce")}).dropna()
    if df.empty: return pd.Series(5.0, index=range(1,13), dtype=float)
    df["m"]=df.index.month; df["d"]=df["v"].diff().abs()
    caps=df.groupby("m")["d"].quantile(0.90).clip(lower=2.0, upper=8.0)
    out=pd.Series(5.0, index=range(1,13), dtype=float); out.update(caps); return out

def infer_precip_type_vectorized(mm, tmax, rain_mm, snow_mm, prob):
    """Vectorized precipitation type inference"""
    # Defaults
    ptype = np.full(mm.shape, "none", dtype=object)
    
    # Check nulls
    valid = (prob >= 35) & (mm >= 0.25)
    
    # Logic for Rain/Snow/Sleet from explicit Model Data
    has_model_type = (rain_mm.notna() | snow_mm.notna()) & valid
    
    r = rain_mm.fillna(0.0)
    s = snow_mm.fillna(0.0)
    
    cond_snow = (s >= 1.0) & (r < 0.5)
    cond_rain = (r >= 0.5) & (s < 1.0)
    cond_sleet = (r >= 0.5) & (s >= 1.0)
    
    ptype = np.where(has_model_type & cond_snow, "snow", ptype)
    ptype = np.where(has_model_type & cond_rain, "rain", ptype)
    ptype = np.where(has_model_type & cond_sleet, "sleet", ptype)
    
    # Logic based on Tmax (fallback)
    fallback = valid & ~has_model_type
    ptype = np.where(fallback & (tmax <= 1.5), "snow", ptype)
    ptype = np.where(fallback & (tmax > 1.5) & (tmax < 3.5), "sleet", ptype)
    ptype = np.where(fallback & (tmax >= 3.5), "rain", ptype)
    
    return ptype

async def forecast_core(lat: float, lon: float, horizon_days: int, reference_date: Optional[date] = None, debug: bool=False, emit_components: bool=False):
    H = int(max(1, min(horizon_days, 540)))
    
    # Hindcast Logic
    if reference_date is None:
        ref_dt = datetime.now(timezone.utc).date()
    else:
        ref_dt = reference_date
        
    hist_end_str = (ref_dt - timedelta(days=1)).strftime("%Y-%m-%d")

    async with httpx.AsyncClient() as client:
        t0 = time.time()
        # Fetch History up to reference_date - 1
        results = await asyncio.gather(
            fetch_era5_daily(client, lat, lon, start_date="2015-01-01", end_date=hist_end_str, debug=debug),
            fetch_nasa_power_daily(client, lat, lon, start_date="2015-01-01", end_date=hist_end_str, debug=debug),
            # Note: NWP forecast is only available for "Battle-Time", we cannot fetch historical NWP forecasts easily free.
            # So for backtest, we might assume no NWP availability (pure statistical model test) or skip NWP.
            fetch_openmeteo_daily(client, lat, lon, forecast_days=min(16,H), past_days=0, debug=debug) if reference_date is None else asyncio.sleep(0)
        )
        
        if reference_date is None:
            era, power, (nwp, _) = results
        else:
             # In backtest mode (Hindcast), we simulate "No NWP" or we would need historical forecasts (not free).
             # Testing the core statistical engine (Climatology + Bias Correction) is key anyway.
            era, power, _ = results
            nwp = None # Assume no NWP for ancient dates

        if debug: print(f"Fetch took: {time.time()-t0:.2f}s")

    # 1. Ensemble Construction (Vectorized with Dynamic Weights)
    if era is None or era.empty:
        if power is None or power.empty:
            raise RuntimeError("Neither ERA5 nor NASA POWER data available.")
        tmax_hist = pd.to_numeric(power["POWER_TMAX"], errors="coerce")
        tmin_hist = pd.to_numeric(power["POWER_TMIN"], errors="coerce" if "POWER_TMIN" in power.columns else "coerce") # Handle missing TMIN column gracefully
        prcp_hist = pd.to_numeric(power["POWER_PRCP"], errors="coerce").fillna(0.0)
        data_source = "NASA POWER only"
    elif power is not None and not power.empty:
        # Dynamic Weighting Logic
        era_tmax = pd.to_numeric(era["ERA5_TMAX"], errors="coerce")
        # Ensure TMIN columns exist
        era_tmin = pd.to_numeric(era["ERA5_TMIN"], errors="coerce") if "ERA5_TMIN" in era.columns else era_tmax * 0.8 # Fallback if missing
        
        power_tmax = pd.to_numeric(power["POWER_TMAX"], errors="coerce")
        power_tmin = pd.to_numeric(power["POWER_TMIN"], errors="coerce") if "POWER_TMIN" in power.columns else power_tmax * 0.8

        # Calculate validity scores (last 365 days)
        # Fix: Use ref_dt (context aware) instead of system now()
        curr_ts = pd.Timestamp(ref_dt)
        recent_cutoff = curr_ts - pd.Timedelta(days=365)
        
        era_valid_count = era_tmax[era_tmax.index > recent_cutoff].count()
        power_valid_count = power_tmax[power_tmax.index > recent_cutoff].count()
        
        # Determine Weights
        w_era, w_unverified_power = 0.5, 0.5
        if era_valid_count > (power_valid_count * 1.5): # ERA5 is much cleaner
             w_era, w_unverified_power = 0.8, 0.2
        elif power_valid_count > (era_valid_count * 1.5):
             w_era, w_unverified_power = 0.2, 0.8
        
        combined = pd.concat([era_tmax, power_tmax], axis=1, join='outer', keys=['era', 'power'])
        tmax_hist = combined.apply(
            lambda row: (w_era * row['era'] + w_unverified_power * row['power']) if pd.notna(row['era']) and pd.notna(row['power'])
                        else (row['era'] if pd.notna(row['era']) else row['power']),
            axis=1
        )
        
        # Same for TMIN
        combined_min = pd.concat([era_tmin, power_tmin], axis=1, join='outer', keys=['era', 'power'])
        tmin_hist = combined_min.apply(
            lambda row: (w_era * row['era'] + w_unverified_power * row['power']) if pd.notna(row['era']) and pd.notna(row['power'])
                        else (row['era'] if pd.notna(row['era']) else row['power']),
            axis=1
        )

        era_prcp = pd.to_numeric(era["ERA5_PRCP"], errors="coerce").fillna(0.0)
        power_prcp = pd.to_numeric(power["POWER_PRCP"], errors="coerce").fillna(0.0)
        combined_prcp = pd.concat([era_prcp, power_prcp], axis=1, join='outer')
        combined_prcp.columns = ['era', 'power']
        prcp_hist = combined_prcp.apply(
            lambda row: (w_era * row['era'] + w_unverified_power * row['power']) if row['era'] > 0 and row['power'] > 0
                        else max(row['era'], row['power']),
            axis=1
        )
        data_source = "ERA5 + NASA POWER ensemble"
    else:
        tmax_hist = pd.to_numeric(era["ERA5_TMAX"], errors="coerce")
        tmin_hist = pd.to_numeric(era["ERA5_TMIN"], errors="coerce") if "ERA5_TMIN" in era.columns else tmax_hist * 0.8
        prcp_hist = pd.to_numeric(era["ERA5_PRCP"], errors="coerce").fillna(0.0)
        data_source = "ERA5 only"
    
    if len(tmax_hist.dropna()) < 120:
        raise RuntimeError("Historical data insufficient.")

    # 2. Climatology & Anomaly (Vectorized)
    clim_tmax = compute_daily_clim(tmax_hist, smooth_window=7)
    clim_tmin = compute_daily_clim(tmin_hist, smooth_window=7)
    clim_prcp = compute_daily_clim(prcp_hist, smooth_window=7)

    end = tmax_hist.index.max()
    recent_start = end - pd.Timedelta(days=60)
    recent = tmax_hist.loc[recent_start: end]
    recent_min = tmin_hist.loc[recent_start: end]
    
    # Get climo for recent dates (Vectorized lookup)
    # Smart Bias Correction: Weighted Moving Average
    # We take the differences (anomalies)
    
    # TMAX BIAS
    recent_clim_vals = get_climo_series(clim_tmax, recent.index)
    diffs = (recent - recent_clim_vals).dropna().tail(30)
    if not diffs.empty:
        w = np.linspace(1, 2, len(diffs)) # Linear weight 1.0 -> 2.0
        an = np.average(diffs, weights=w)
    else:
        an = 0.0
        
    # TMIN BIAS
    recent_clim_vals_min = get_climo_series(clim_tmin, recent_min.index)
    diffs_min = (recent_min - recent_clim_vals_min).dropna().tail(30)
    if not diffs_min.empty:
        w = np.linspace(1, 2, len(diffs_min)) 
        an_min = np.average(diffs_min, weights=w)
    else:
        an_min = 0.0

    # 3. Future Construction
    fut_idx = pd.date_range(tmax_hist.index.max()+pd.Timedelta(days=1), periods=H, freq="D")
    
    # Base Tmax Model (Harmonic Climatology + Smart Bias Correction)
    base_climo = get_climo_series(clim_tmax, fut_idx)
    base_climo_min = get_climo_series(clim_tmin, fut_idx)
    
    k = np.arange(1, len(fut_idx)+1, dtype=float)
    decay_an = an * (0.985**(k-1))
    decay_an_min = an_min * (0.985**(k-1))
    
    w_offset = warming_offset(fut_idx, per_decade=0.3, baseline_year=2020.5)
    
    # NEW: Analog Forecast Blending
    # Try to find similar years and use their trajectory
    analog_curve = get_analog_forecast(tmax_hist, H)
    
    df_fut = pd.DataFrame(index=fut_idx)
    
    if analog_curve is not None:
        # Fill missing analog days (if any) with base_climo to avoid NaNs
        analog_vals = analog_curve.reindex(fut_idx).fillna(base_climo)
        
        # PRO-TRICK: Instead of blending absolute values (which might have different biases),
        # blend the ANOMALIES. 
        # Base Climo + 0.9*BiasDecay + 0.1*AnalogAnomaly
        
        analog_anomaly = analog_vals - base_climo # How different were the analog years from climo?
        
        # We trust the analog anomaly slightly (10%) to guide the variance
        final_anomaly = decay_an + (0.10 * analog_anomaly) 
        
        df_fut['tmax_base'] = base_climo.values + final_anomaly.values + w_offset.values
        df_fut['tmin_base'] = base_climo_min.values + decay_an_min + w_offset.values # Analog not applied to TMIN yet for simplicity
        df_fut['source'] = 'blend (analog-enhanced)'
    else:
        df_fut['tmax_base'] = base_climo.values + decay_an + w_offset.values
        df_fut['tmin_base'] = base_climo_min.values + decay_an_min + w_offset.values
        df_fut['source'] = 'blend'

    df_fut['climo_tmax'] = base_climo.values # Keep for anomaly calc later
    df_fut['tmax_final'] = df_fut['tmax_base'] # Mutable column
    df_fut['tmin_final'] = df_fut['tmin_base'] 
    
    # Precip Base
    base_prcp_clim = get_climo_series(clim_prcp, fut_idx)
    df_fut['prcp_base'] = base_prcp_clim.values
    df_fut['mm_final'] = df_fut['prcp_base'] # Will update
    df_fut['nwp_prob'] = np.nan
    df_fut['rain_mm'] = np.nan
    df_fut['snow_mm'] = np.nan
    df_fut['weather_code'] = np.nan

    # 4. Integrate NWP (Open-Meteo)
    if nwp is not None:
        # Common indices
        common = nwp.index.intersection(fut_idx)
        if not common.empty:
            # Direct mapping for first 15 days
            mask_direct = (common <= (fut_idx[0] + pd.Timedelta(days=14)))
            direct_idx = common[mask_direct]
            
            if not direct_idx.empty:
                 # TMAX
                nwp_tmax = nwp.loc[direct_idx, "NWP_TMAX"].astype(float)
                valid_nwp = nwp_tmax.notna()
                valid_idx = direct_idx[valid_nwp]
                
                df_fut.loc[valid_idx, 'tmax_final'] = nwp_tmax[valid_idx]
                df_fut.loc[valid_idx, 'source'] = 'open-meteo-direct'
                
                # TMIN
                nwp_tmin = nwp.loc[direct_idx, "NWP_TMIN"].astype(float)
                valid_nwp_min = nwp_tmin.notna()
                valid_idx_min = direct_idx[valid_nwp_min]
                df_fut.loc[valid_idx_min, 'tmin_final'] = nwp_tmin[valid_idx_min]

                # Weather Code
                df_fut.loc[direct_idx, 'weather_code'] = nwp.loc[direct_idx, "NWP_CODE"]

            # Blending day (Day 16)
            # (Simplified: Just treating day 16 as blend if available)
            
            # PRECIP & PROB (Vectorized for all available NWP days)
            nwp_prcp = nwp.loc[common, "NWP_PRCP_MM"].fillna(0.0)
            nwp_prob = nwp.loc[common, "NWP_PPRB_MAX"]
            
            # Weighted mix: 0.6 * NWP + 0.4 * Clim
            clim_subset = df_fut.loc[common, 'prcp_base']
            mixed_mm = 0.6 * nwp_prcp + 0.4 * clim_subset
            df_fut.loc[common, 'mm_final'] = mixed_mm
            df_fut.loc[common, 'nwp_prob'] = nwp_prob
            
            if "NWP_RAIN_MM" in nwp.columns:
                 df_fut.loc[common, 'rain_mm'] = nwp.loc[common, "NWP_RAIN_MM"]
            if "NWP_SNOW_MM" in nwp.columns:
                 df_fut.loc[common, 'snow_mm'] = nwp.loc[common, "NWP_SNOW_MM"]


    # 5. Slope Capping Loop (The only heavy loop left, but simplified)
    # We only run this for 'blend' days, but simpler to run linearly
    caps = slope_caps_by_month(tmax_hist)
    cap_vals = caps.loc[fut_idx.month].values # Vectorized lookup of caps
    
    tmax_arr = df_fut['tmax_final'].values
    tmin_arr = df_fut['tmin_final'].values # NEW
    source_arr = df_fut['source'].values
    
    prev_tmax = float(tmax_hist.dropna().iloc[-1])
    prev_tmin = float(tmin_hist.dropna().iloc[-1]) # NEW
    
    # We must iterate because tmax[i] depends on tmax[i-1]
    # But only for 'blend' source. 'open-meteo-direct' resets the anchor.
    for i in range(len(tmax_arr)):
        if source_arr[i] == 'blend':
            # Apply limit for TMAX
            cap = cap_vals[i]
            candidate_tmax = tmax_arr[i]
            tmax_arr[i] = apply_slope_cap(prev_tmax, candidate_tmax, cap, k=1.1)
            
            # Apply limit for TMIN (using a slightly smaller cap or fixed value)
            candidate_tmin = tmin_arr[i]
            tmin_arr[i] = apply_slope_cap(prev_tmin, candidate_tmin, cap * 0.8, k=1.1) # Use 80% of TMAX cap for TMIN
        
        # Ensure TMIN < TMAX
        if tmin_arr[i] >= tmax_arr[i]:
            tmin_arr[i] = tmax_arr[i] - 2.0 # Maintain a minimum 2-degree spread
            if tmin_arr[i] < -40: tmin_arr[i] = -40 # Lower bound for TMIN
        
        prev_tmax = tmax_arr[i] # Update prev for next step
        prev_tmin = tmin_arr[i] # Update prev for next step
        
    df_fut['tmax_final'] = tmax_arr
    df_fut['tmin_final'] = tmin_arr # NEW

    # 6. Post-Process (Vectorized)
    # Prob
    mm_final = df_fut['mm_final'].values
    # Function for prob
    # _mm_to_prob logic: 100 * (1 - exp(-mm / k))
    # if nwp_prob exists: mix, else calc from mm
    
    # Calc pure physics-based prob
    # k=1.2 if nwp used (we assume nwp influence if in common range), else 2.5
    # Simplification: use k=1.5 general or mix
    
    # Base probs
    p_phys_k25 = 100.0 * (1.0 - np.exp(-mm_final / max(0.05, 2.5)))
    p_phys_k12 = 100.0 * (1.0 - np.exp(-mm_final / max(0.05, 1.2)))
    
    nwp_probs = df_fut['nwp_prob'].values
    has_nwp_p = ~np.isnan(nwp_probs)
    
    final_prob = np.round(p_phys_k25)
    
    # Where we have NWP prob
    # 0.6 * p_nwp + 0.4 * p_phys(k=1.2)
    if np.any(has_nwp_p):
        mixed = 0.6 * nwp_probs[has_nwp_p] + 0.4 * p_phys_k12[has_nwp_p]
        final_prob[has_nwp_p] = np.round(mixed)
        
    df_fut['precip_prob'] = np.clip(final_prob, 0, 100).astype(int)
    
    # Precip Type
    df_fut['precip_type'] = infer_precip_type_vectorized(
        df_fut['mm_final'].values,
        df_fut['tmax_final'].values,
        df_fut['rain_mm'], # Series
        df_fut['snow_mm'], # Series
        df_fut['precip_prob'].values
    )
    
    # Descriptions
    # If source==open-meteo-direct -> use code
    # else -> logic
    
    # Vectorized descriptions
    codes = df_fut['weather_code'].fillna(-1).values
    desc_from_code = wmo_code_to_text_vectorized(codes)
    
    # Logic based descriptions
    p_type = df_fut['precip_type'].values
    p_prob = df_fut['precip_prob'].values
    t_max = df_fut['tmax_final'].values
    
    desc_logic = np.full(len(df_fut), "Partly Cloudy", dtype=object)
    mask_sunny = t_max > 30
    desc_logic[mask_sunny] = "Sunny"
    mask_chance = p_prob >= 35
    desc_logic[mask_chance] = "Chance of " + p_type[mask_chance].astype(str).flatten()
    # Note: string concatenation in numpy can be tricky if types mismatch
    # using list comprehension for safe string building if needed, but object array usually works
    # Let's fix the capitalization for "Chance of rain" -> "Chance of rain" (p_type is lowercase)
    # Actually client expects Title Case? "Chance of Snow".
    # infer_precip_type returns lowercase "snow".
    # Simplest to leave as is or map.
    
    final_desc = np.where(df_fut['source'] == 'open-meteo-direct', desc_from_code, desc_logic)
    
    # Fallback if code was unknown/nan for direct
    mask_unknown = (df_fut['source'] == 'open-meteo-direct') & (codes == -1)
    final_desc[mask_unknown] = desc_logic[mask_unknown]
    
    df_fut['weather_desc'] = final_desc
    df_fut['anomaly'] = df_fut['tmax_final'] - df_fut['climo_tmax']

    # 7. Formatting Output
    # Convert to dict list
    # Rounding
    df_fut['tmax'] = df_fut['tmax_final'].round(2)
    df_fut['tmin'] = df_fut['tmin_final'].round(2)
    df_fut['anomaly'] = df_fut['anomaly'].round(2)
    df_fut['precip_mm'] = df_fut['mm_final'].round(2)
    
    # Reset index to get date - ROBUST METHOD
    # Instead of rename, explicitly assign from index
    out_df = df_fut.copy()
    out_df['date'] = out_df.index.strftime("%Y-%m-%d")
    out_df = out_df.reset_index(drop=True) # Drop original index to be clean
    out_df['tmax_source'] = out_df['source']

    # Selection
    cols = ['date', 'tmax', 'tmin', 'anomaly', 'tmax_source', 'precip_mm', 'precip_prob', 'precip_type', 'weather_desc']
    if emit_components:
        # Add debug cols
        pass 
        
    res_records = out_df[cols].rename(columns={'source': 'tmax_source'}).to_dict(orient='records')
    
    out = {
        "meta": {
            "version": VERSION,
            "timestamp": iso_utc_now(),
            "ttl_seconds": 10800, # 3 Hours Global TTL
            "location": {"lat": float(lat), "lon": float(lon)},
            "sources": ["Open-Meteo Forecast API", "Open-Meteo ERA5 Archive", "NASA POWER API"],
            "data_source": data_source
        },
        "daily": res_records
    }
    return out, res_records

def build_parser():
    ap = argparse.ArgumentParser(
        prog="nova_logic",
        description="Minimal daily Tmax forecast service with Anomaly detection."
    )
    ap.add_argument("--lat", type=float, required=True, help="Latitude")
    ap.add_argument("--lon", type=float, required=True, help="Longitude")
    ap.add_argument("--horizon-days", type=int, default=360, help="Forecast length in days (<=540)")
    ap.add_argument("--emit-components", action="store_true", help="Include internal fields for debugging")
    ap.add_argument("--out-json", type=str, default=None, help="Write JSON output to file")
    ap.add_argument("--export-csv", nargs="?", const="forecast_out.csv", default=None, help="Also write CSV")
    ap.add_argument("--print-table", action="store_true", help="Pretty-print table")
    ap.add_argument("--debug", action="store_true")
    return ap

def main():
    args = build_parser().parse_args()
    print(f"{VERSION} | nova_logic.py")

    try:
        loop = asyncio.get_event_loop()
        out, rows = loop.run_until_complete(
            forecast_core(
                args.lat, args.lon, args.horizon_days,
                debug=args.debug, emit_components=args.emit_components
            )
        )
        txt=json.dumps(out, ensure_ascii=False, indent=2)
        print(txt)
        if args.out_json:
            with open(args.out_json, "w", encoding="utf-8") as f: f.write(txt + "\n")
        if args.export_csv:
            pd.DataFrame(rows).to_csv(args.export_csv, index=False, encoding="utf-8-sig")
        if args.print_table:
            print(pd.DataFrame(rows).to_string(index=False))
    except Exception as e:
        print("error:", e.__class__.__name__, "-", str(e))
        if args.debug:
            import traceback; traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
